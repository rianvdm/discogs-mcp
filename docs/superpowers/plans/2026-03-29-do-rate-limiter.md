# Durable Object Rate Limiter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-user KV-based throttle in discogs-mcp with a singleton Durable Object that coordinates all Discogs API requests, reads response headers for real budget tracking, and queues requests when budget is low.

**Architecture:** A new `DiscogsRateLimiter` Durable Object class acts as a proxy for all outbound Discogs API calls. Workers send `{ url, method, headers, body? }` to the DO, which gates requests based on `X-Discogs-Ratelimit-Remaining` headers, queues when budget is low, and absorbs 429s. The existing `DiscogsClient` replaces `throttleRequest()` + `fetchWithRetry()` with a single call through the DO stub.

**Tech Stack:** Cloudflare Workers, Durable Objects (transactional storage + alarms), Vitest

**Design spec:** `05-personal/side-projects/plans/2026-03-29-discogs-rate-limiter-design.md` (in product-ai repo)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/rate-limiter/types.ts` | Request/response interfaces shared between DO and client |
| Create | `src/rate-limiter/durable-object.ts` | The `DiscogsRateLimiter` DO class — budget tracking, queuing, 429 handling |
| Create | `src/rate-limiter/client.ts` | Thin wrapper that sends requests to the DO stub |
| Create | `test/rate-limiter/durable-object.test.ts` | Unit tests for the DO logic |
| Create | `test/rate-limiter/client.test.ts` | Unit tests for the client wrapper |
| Modify | `src/types/env.ts` | Add `RATE_LIMITER` DO binding to `Env` interface |
| Modify | `src/clients/discogs.ts` | Remove throttle logic, accept DO stub, route fetches through rate limiter |
| Modify | `src/clients/cachedDiscogs.ts` | Remove `setThrottleUser` forwarding |
| Modify | `src/mcp/tools/authenticated.ts` | Pass DO stub when creating DiscogsClient |
| Modify | `src/mcp/resources/discogs.ts` | Pass DO stub when creating DiscogsClient |
| Modify | `wrangler.toml` | Add DO binding, remove `MCP_RL` KV namespace |
| Modify | `test/clients/discogs.test.ts` | Update tests for new DiscogsClient constructor |

---

### Task 1: Define shared types

**Files:**
- Create: `src/rate-limiter/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/rate-limiter/types.ts

/** Request from Worker to the rate limiter DO */
export interface RateLimiterRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** Response from the rate limiter DO back to Worker */
export interface RateLimiterResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** Internal budget state persisted in DO storage */
export interface BudgetState {
  remaining: number
  limit: number
  lastUpdated: number
}

/** DO stub interface used by the client wrapper */
export interface RateLimiterStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
}
```

- [ ] **Step 2: Commit**

```bash
git add src/rate-limiter/types.ts
git commit -m "feat: add rate limiter types"
```

---

### Task 2: Implement the Durable Object

**Files:**
- Create: `src/rate-limiter/durable-object.ts`
- Create: `test/rate-limiter/durable-object.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/rate-limiter/durable-object.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We'll test the core logic by extracting it into testable functions.
// The DO class itself is thin — it delegates to these functions.

import { getDelay, updateBudgetFromHeaders, shouldRejectQueue } from '../../src/rate-limiter/durable-object'
import type { BudgetState } from '../../src/rate-limiter/types'

describe('getDelay', () => {
  it('returns 0 when remaining >= 20', () => {
    expect(getDelay(20)).toBe(0)
    expect(getDelay(60)).toBe(0)
  })

  it('returns 1000 when remaining 10-19', () => {
    expect(getDelay(10)).toBe(1000)
    expect(getDelay(19)).toBe(1000)
  })

  it('returns 3000 when remaining 5-9', () => {
    expect(getDelay(5)).toBe(3000)
    expect(getDelay(9)).toBe(3000)
  })

  it('returns 10000 when remaining 1-4', () => {
    expect(getDelay(1)).toBe(10000)
    expect(getDelay(4)).toBe(10000)
  })

  it('returns -1 (must queue) when remaining is 0', () => {
    expect(getDelay(0)).toBe(-1)
  })
})

describe('updateBudgetFromHeaders', () => {
  it('updates remaining and limit from headers', () => {
    const headers: Record<string, string> = {
      'x-discogs-ratelimit': '60',
      'x-discogs-ratelimit-remaining': '42',
    }
    const budget: BudgetState = { remaining: 60, limit: 60, lastUpdated: 0 }
    const updated = updateBudgetFromHeaders(budget, headers)
    expect(updated.remaining).toBe(42)
    expect(updated.limit).toBe(60)
    expect(updated.lastUpdated).toBeGreaterThan(0)
  })

  it('preserves existing state when headers are missing', () => {
    const budget: BudgetState = { remaining: 30, limit: 60, lastUpdated: 1000 }
    const updated = updateBudgetFromHeaders(budget, {})
    expect(updated.remaining).toBe(30)
    expect(updated.limit).toBe(60)
  })
})

describe('shouldRejectQueue', () => {
  it('returns false when queue is under max depth', () => {
    expect(shouldRejectQueue(19)).toBe(false)
  })

  it('returns true when queue is at max depth', () => {
    expect(shouldRejectQueue(20)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/rate-limiter/durable-object.test.ts`
Expected: FAIL — cannot resolve imports

- [ ] **Step 3: Implement the Durable Object**

```typescript
// src/rate-limiter/durable-object.ts
import type { RateLimiterRequest, RateLimiterResponse, BudgetState } from './types'

const MAX_QUEUE_DEPTH = 20
const QUEUE_TIMEOUT_MS = 30_000
const DEFAULT_PAUSE_MS = 60_000
const WINDOW_RESET_MS = 60_000

/** Exported for testing — compute delay based on remaining budget */
export function getDelay(remaining: number): number {
  if (remaining >= 20) return 0
  if (remaining >= 10) return 1000
  if (remaining >= 5) return 3000
  if (remaining >= 1) return 10000
  return -1 // must queue until window resets
}

/** Exported for testing — update budget from Discogs response headers */
export function updateBudgetFromHeaders(
  budget: BudgetState,
  headers: Record<string, string>,
): BudgetState {
  const remaining = headers['x-discogs-ratelimit-remaining']
  const limit = headers['x-discogs-ratelimit']
  return {
    remaining: remaining != null ? parseInt(remaining, 10) : budget.remaining,
    limit: limit != null ? parseInt(limit, 10) : budget.limit,
    lastUpdated: remaining != null ? Date.now() : budget.lastUpdated,
  }
}

/** Exported for testing — check if queue is full */
export function shouldRejectQueue(queueLength: number): boolean {
  return queueLength >= MAX_QUEUE_DEPTH
}

interface QueuedRequest {
  resolve: (response: RateLimiterResponse) => void
  reject: (error: Error) => void
  request: RateLimiterRequest
  enqueuedAt: number
}

export class DiscogsRateLimiter implements DurableObject {
  private state: DurableObjectState
  private budget: BudgetState = { remaining: 60, limit: 60, lastUpdated: 0 }
  private queue: QueuedRequest[] = []
  private processing = false
  private paused = false

  constructor(state: DurableObjectState) {
    this.state = state
    // Restore budget from storage on wake
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<BudgetState>('budget')
      if (stored) {
        this.budget = stored
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const limiterReq: RateLimiterRequest = await request.json()
    const response = await this.enqueue(limiterReq)
    return new Response(JSON.stringify(response), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async alarm(): Promise<void> {
    // Window has reset — restore budget to limit
    this.budget.remaining = this.budget.limit
    this.budget.lastUpdated = Date.now()
    await this.state.storage.put('budget', this.budget)

    // If there are queued requests, start draining
    if (this.queue.length > 0) {
      this.paused = false
      this.drainQueue()
    }
  }

  private enqueue(request: RateLimiterRequest): Promise<RateLimiterResponse> {
    if (shouldRejectQueue(this.queue.length)) {
      return Promise.resolve({
        status: 503,
        headers: {},
        body: JSON.stringify({ error: 'Rate limiter queue full, retry later' }),
      })
    }

    return new Promise<RateLimiterResponse>((resolve, reject) => {
      const entry: QueuedRequest = {
        resolve,
        reject,
        request,
        enqueuedAt: Date.now(),
      }

      this.queue.push(entry)

      // Set a timeout so requests don't wait forever
      setTimeout(() => {
        const idx = this.queue.indexOf(entry)
        if (idx !== -1) {
          this.queue.splice(idx, 1)
          resolve({
            status: 504,
            headers: {},
            body: JSON.stringify({ error: 'Rate limiter timeout' }),
          })
        }
      }, QUEUE_TIMEOUT_MS)

      // Start processing if not already running
      if (!this.processing) {
        this.drainQueue()
      }
    })
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      if (this.paused) {
        this.processing = false
        return // alarm will restart draining
      }

      // Check for timed-out entries
      const entry = this.queue[0]
      if (Date.now() - entry.enqueuedAt >= QUEUE_TIMEOUT_MS) {
        this.queue.shift()
        continue // already resolved by setTimeout
      }

      // Apply delay based on budget
      const delay = getDelay(this.budget.remaining)
      if (delay === -1) {
        // Budget exhausted — set alarm for window reset and pause
        await this.scheduleWindowReset()
        this.paused = true
        this.processing = false
        return
      }

      if (delay > 0) {
        await this.sleep(delay)
      }

      // Dequeue and execute
      this.queue.shift()
      const response = await this.executeRequest(entry.request)

      if (response.status === 429) {
        // 429 despite our gating — pause everything
        this.budget.remaining = 0
        await this.state.storage.put('budget', this.budget)

        // Parse Retry-After
        const retryAfter = response.headers['retry-after']
        const pauseMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : DEFAULT_PAUSE_MS

        // Re-queue this request at the front
        this.queue.unshift(entry)

        // Schedule alarm to resume
        await this.state.storage.setAlarm(Date.now() + pauseMs)
        this.paused = true
        this.processing = false
        return
      }

      // Update budget from response headers
      this.budget = updateBudgetFromHeaders(this.budget, response.headers)
      await this.state.storage.put('budget', this.budget)

      // Schedule a window reset alarm (resets if no requests come in for 60s)
      await this.scheduleWindowReset()

      // Decrement our local remaining count (the header already reflects this,
      // but if we fire multiple requests before getting headers back, this
      // helps us stay conservative)
      entry.resolve(response)
    }

    this.processing = false
  }

  private async executeRequest(req: RateLimiterRequest): Promise<RateLimiterResponse> {
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body ?? undefined,
      })

      // Read headers into a plain object
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })

      const body = await response.text()

      return { status: response.status, headers, body }
    } catch (error) {
      return {
        status: 502,
        headers: {},
        body: JSON.stringify({
          error: `Rate limiter fetch error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }),
      }
    }
  }

  private async scheduleWindowReset(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + WINDOW_RESET_MS)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/rate-limiter/durable-object.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rate-limiter/durable-object.ts test/rate-limiter/durable-object.test.ts
git commit -m "feat: add DiscogsRateLimiter Durable Object"
```

---

### Task 3: Implement the client wrapper

**Files:**
- Create: `src/rate-limiter/client.ts`
- Create: `test/rate-limiter/client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/rate-limiter/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rateLimitedFetch } from '../../src/rate-limiter/client'
import type { RateLimiterResponse, RateLimiterStub } from '../../src/rate-limiter/types'

function createMockStub(response: RateLimiterResponse): RateLimiterStub {
  return {
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  }
}

describe('rateLimitedFetch', () => {
  it('sends request to DO and returns a Response', async () => {
    const stub = createMockStub({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"username":"testuser"}',
    })

    const response = await rateLimitedFetch(stub, 'https://api.discogs.com/users/testuser', {
      method: 'GET',
      headers: { Authorization: 'OAuth ...', 'User-Agent': 'discogs-mcp/1.0.0' },
    })

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.username).toBe('testuser')

    // Verify the stub was called with the right payload
    expect(stub.fetch).toHaveBeenCalledOnce()
    const callArgs = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const sentRequest = callArgs[0] as Request
    const sentBody = JSON.parse(await sentRequest.text())
    expect(sentBody.url).toBe('https://api.discogs.com/users/testuser')
    expect(sentBody.method).toBe('GET')
  })

  it('returns error response when DO returns 503', async () => {
    const stub = createMockStub({
      status: 503,
      headers: {},
      body: '{"error":"Rate limiter queue full, retry later"}',
    })

    const response = await rateLimitedFetch(stub, 'https://api.discogs.com/releases/123', {
      method: 'GET',
      headers: {},
    })

    expect(response.status).toBe(503)
  })

  it('passes POST body through to the DO', async () => {
    const stub = createMockStub({
      status: 200,
      headers: {},
      body: '{}',
    })

    await rateLimitedFetch(stub, 'https://api.discogs.com/some/endpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"rating":5}',
    })

    const callArgs = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const sentBody = JSON.parse(await (callArgs[0] as Request).text())
    expect(sentBody.method).toBe('POST')
    expect(sentBody.body).toBe('{"rating":5}')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/rate-limiter/client.test.ts`
Expected: FAIL — cannot resolve import

- [ ] **Step 3: Implement the client wrapper**

```typescript
// src/rate-limiter/client.ts
import type { RateLimiterRequest, RateLimiterResponse, RateLimiterStub } from './types'

/**
 * Send a fetch request through the rate limiter Durable Object.
 * Returns a standard Response object so callers don't need to change.
 */
export async function rateLimitedFetch(
  stub: RateLimiterStub,
  url: string,
  init: { method?: string; headers?: Record<string, string> | HeadersInit; body?: string },
): Promise<Response> {
  // Normalize headers to a plain object
  const headers: Record<string, string> = {}
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value
      })
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value
      }
    } else {
      Object.assign(headers, init.headers)
    }
  }

  const payload: RateLimiterRequest = {
    url,
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  }

  const doResponse = await stub.fetch(
    new Request('https://do-internal/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )

  const result: RateLimiterResponse = await doResponse.json()

  // Reconstruct a standard Response from the DO's response
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/rate-limiter/client.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rate-limiter/client.ts test/rate-limiter/client.test.ts
git commit -m "feat: add rate limiter client wrapper"
```

---

### Task 4: Add DO binding to Env and wrangler config

**Files:**
- Modify: `src/types/env.ts`
- Modify: `wrangler.toml`

- [ ] **Step 1: Update Env interface**

In `src/types/env.ts`, add the DO namespace binding. The full file should become:

```typescript
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {
  // Discogs OAuth credentials
  DISCOGS_CONSUMER_KEY: string
  DISCOGS_CONSUMER_SECRET: string

  // JWT secret for legacy session-based handler (src/index.ts)
  JWT_SECRET: string

  // OAuth provider helpers (injected by @cloudflare/workers-oauth-provider at runtime)
  OAUTH_PROVIDER: OAuthHelpers

  // KV namespaces for logging and sessions
  MCP_LOGS: KVNamespace
  MCP_SESSIONS: KVNamespace

  // KV namespace for OAuth provider state (tokens, grants, client registrations)
  OAUTH_KV: KVNamespace

  // Durable Object namespace for Discogs API rate limiting
  RATE_LIMITER: DurableObjectNamespace
}
```

- [ ] **Step 2: Update wrangler.toml**

Add the DO class binding and migration. Remove the `MCP_RL` KV namespaces (dead code). The relevant additions/changes:

Add after the `[observability]` section:

```toml
# Durable Object for coordinated Discogs API rate limiting
[durable_objects]
bindings = [
  { name = "RATE_LIMITER", class_name = "DiscogsRateLimiter" }
]

[[migrations]]
tag = "v1"
new_classes = ["DiscogsRateLimiter"]
```

Remove these lines from the default environment:

```toml
[[kv_namespaces]]
binding = "MCP_RL"
id = "b4caaaa688cc45d2a9a85fe67ba53bfc"
```

Remove these lines from `[env.production]`:

```toml
[[env.production.kv_namespaces]]
binding = "MCP_RL"
id = "bfc831cedceb4a08a6d997909c3899ce"
```

Also add the DO binding to the production environment:

```toml
[env.production.durable_objects]
bindings = [
  { name = "RATE_LIMITER", class_name = "DiscogsRateLimiter" }
]
```

- [ ] **Step 3: Export the DO class from the worker entry point**

In `src/index-oauth.ts`, add the re-export so Wrangler can find the DO class. Add at the top of the file, after existing imports:

```typescript
// Re-export Durable Object class for Wrangler binding
export { DiscogsRateLimiter } from './rate-limiter/durable-object'
```

- [ ] **Step 4: Verify the project builds**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds (no actual deployment)

- [ ] **Step 5: Commit**

```bash
git add src/types/env.ts wrangler.toml src/index-oauth.ts
git commit -m "feat: add RATE_LIMITER DO binding, remove dead MCP_RL KV"
```

---

### Task 5: Refactor DiscogsClient to use rate limiter

**Files:**
- Modify: `src/clients/discogs.ts`
- Modify: `src/clients/cachedDiscogs.ts`

This is the core integration. `DiscogsClient` drops all throttle logic and routes fetches through the DO.

- [ ] **Step 1: Update DiscogsClient constructor and remove throttle code**

In `src/clients/discogs.ts`, make these changes:

**Remove** these properties and methods entirely:
- `private lastRequestTime = 0`
- `private kv: KVNamespace | null = null`
- `private throttleUser: string | null = null`
- `private readonly REQUEST_DELAY_MS = 500`
- `setKV(kv: KVNamespace): void`
- `setThrottleUser(username: string): void`
- `private getThrottleKey(): string`
- `private async throttleRequest(): Promise<void>`

**Add** a rate limiter stub property and setter:

```typescript
import { rateLimitedFetch } from '../rate-limiter/client'
import type { RateLimiterStub } from '../rate-limiter/types'

export class DiscogsClient {
  private baseUrl = 'https://api.discogs.com'
  private userAgent = 'discogs-mcp/1.0.0'
  private rateLimiterStub: RateLimiterStub | null = null

  // Retry config — keep for 5xx/network errors, but remove 429 from shouldRetry
  private readonly discogsRetryOptions: RetryOptions = {
    maxRetries: 3,
    initialDelayMs: 3000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    jitterFactor: 0.1,
  }

  /**
   * Set the Durable Object stub for coordinated rate limiting.
   * When set, all Discogs API fetches route through the DO.
   */
  setRateLimiter(stub: RateLimiterStub): void {
    this.rateLimiterStub = stub
  }
```

- [ ] **Step 2: Add a private fetch method that routes through the DO**

Add this method to `DiscogsClient`, replacing the removed `throttleRequest()`:

```typescript
  /**
   * Fetch from Discogs API, routing through the rate limiter DO if available.
   * Falls back to direct fetch if no DO stub is set (e.g., in tests).
   *
   * The DO handles rate limiting and 429 retries. This method does NOT
   * retry 5xx/network errors — the DO passes those through and the
   * caller's existing error handling covers them. This is a deliberate
   * simplification: the DO is the retry authority for rate limits, and
   * the caller throws on non-OK responses as before.
   */
  private async discogsApiFetch(url: string, init: RequestInit): Promise<Response> {
    if (this.rateLimiterStub) {
      return rateLimitedFetch(this.rateLimiterStub, url, {
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      })
    }
    // Fallback: direct fetch (tests, local dev without DO)
    return fetch(url, init)
  }
```

- [ ] **Step 3: Replace all `await this.throttleRequest()` + `fetchWithRetry()` calls**

In every method that calls `await this.throttleRequest()` followed by `fetchWithRetry(url, { headers }, this.discogsRetryOptions)`, replace both lines with:

```typescript
const response = await this.discogsApiFetch(url, { method: 'GET', headers })
if (!response.ok) {
  throw new Error(`HTTP ${response.status}: ${await response.text()}`)
}
```

The methods to update (all follow the same pattern):
- `getRelease` (line ~290)
- `searchCollection` (line ~344)
- `searchCollectionWithQuery` inner loop (line ~425)
- `getUserProfile` (line ~879)
- `searchDatabase` (line ~937)
- `getCollectionFolders` (line ~973)
- `createFolder` (line ~1010)
- `editFolder` (line ~1050)
- `deleteFolder` (line ~1089)
- `moveReleaseToFolder` (line ~1125)
- `addToCollection` (line ~1164)
- `removeFromCollection` (line ~1202)
- `rateRelease` (line ~1238)
- `getCollectionCustomFields` and `editCollectionCustomField` (line ~1279)

For each method:
1. Remove `await this.throttleRequest()`
2. Replace `fetchWithRetry(url, { headers: ... }, this.discogsRetryOptions)` with `this.discogsApiFetch(url, { method: 'GET', headers: { Authorization: authHeader, 'User-Agent': this.userAgent } })`
3. Add `if (!response.ok)` check where the old `fetchWithRetry` would have thrown
4. Remove 429-specific error messages (the DO handles those now) — keep generic error messages

Also remove the 429 check in catch blocks:
```typescript
// REMOVE these patterns:
if (error instanceof Error && error.message.includes('429')) {
  throw new Error('Discogs API rate limit exceeded ...')
}
```

- [ ] **Step 4: Remove the singleton export and update CachedDiscogsClient**

At the bottom of `src/clients/discogs.ts`, remove:
```typescript
export const discogsClient = new DiscogsClient()
```

In `src/clients/cachedDiscogs.ts`:
- Remove `this.client.setKV(kv)` from the constructor
- Remove the `setThrottleUser` method entirely
- Add a `setRateLimiter` pass-through:

```typescript
setRateLimiter(stub: RateLimiterStub): void {
  this.client.setRateLimiter(stub)
}
```

Add the import:
```typescript
import type { RateLimiterStub } from '../rate-limiter/types'
```

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run test/clients/discogs.test.ts`
Expected: Some tests will fail due to the removed singleton export and changed API. We'll fix these in Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/clients/discogs.ts src/clients/cachedDiscogs.ts
git commit -m "refactor: route DiscogsClient through rate limiter DO, remove per-user throttle"
```

---

### Task 6: Update callers to pass DO stub

**Files:**
- Modify: `src/mcp/tools/authenticated.ts`
- Modify: `src/mcp/resources/discogs.ts`

- [ ] **Step 1: Update authenticated tools**

In `src/mcp/tools/authenticated.ts`, find the `setupAuthenticatedClient` function (around line 282). Change:

```typescript
// BEFORE:
const discogsClient = new DiscogsClient()
if (env.MCP_SESSIONS) {
  discogsClient.setKV(env.MCP_SESSIONS)
}
const cachedClient = env.MCP_SESSIONS ? new CachedDiscogsClient(discogsClient, env.MCP_SESSIONS) : null
const client = cachedClient || discogsClient
```

```typescript
// AFTER:
const discogsClient = new DiscogsClient()
// Set up rate limiter DO
if (env.RATE_LIMITER) {
  const id = env.RATE_LIMITER.idFromName('discogs-rate-limiter')
  const stub = env.RATE_LIMITER.get(id)
  discogsClient.setRateLimiter(stub)
}
const cachedClient = env.MCP_SESSIONS ? new CachedDiscogsClient(discogsClient, env.MCP_SESSIONS) : null
const client = cachedClient || discogsClient
```

Also remove the lines that call `setThrottleUser`:
```typescript
// REMOVE:
cachedClient.setThrottleUser(userProfile.username)
// and
discogsClient.setThrottleUser(userProfile.username)
```

- [ ] **Step 2: Update resources**

In `src/mcp/resources/discogs.ts`, apply the same pattern. Find where `DiscogsClient` is created and:
1. Add rate limiter stub setup using `env.RATE_LIMITER`
2. Remove `discogsClient.setKV(env.MCP_SESSIONS)` call
3. Remove `setThrottleUser` calls

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: Some tests may fail due to the removed `discogsClient` singleton import. Fix in next step.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/authenticated.ts src/mcp/resources/discogs.ts
git commit -m "feat: wire up rate limiter DO stub in MCP tools and resources"
```

---

### Task 7: Fix existing tests

**Files:**
- Modify: `test/clients/discogs.test.ts`
- Modify: `test/clients/cachedDiscogs.test.ts`

- [ ] **Step 1: Update discogs.test.ts**

The tests import `discogsClient` singleton which no longer exists. Update to create a new instance:

```typescript
// BEFORE:
import { discogsClient } from '../../src/clients/discogs'

// AFTER:
import { DiscogsClient } from '../../src/clients/discogs'
const discogsClient = new DiscogsClient()
```

Also remove any references to `setKV` or `setThrottleUser` in test setup.

- [ ] **Step 2: Update cachedDiscogs.test.ts**

Remove any references to `setThrottleUser` in test setup. If tests call `cachedClient.setThrottleUser(...)`, remove those lines.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: PASS (all tests)

- [ ] **Step 4: Commit**

```bash
git add test/clients/discogs.test.ts test/clients/cachedDiscogs.test.ts
git commit -m "fix: update tests for new DiscogsClient API"
```

---

### Task 8: Verify build and clean up

**Files:**
- None new — verification only

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Verify the project builds**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds with no errors

- [ ] **Step 3: Run type checking**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Check for orphaned imports**

Search for any remaining references to the removed code:

```bash
grep -rn "throttleRequest\|setThrottleUser\|getThrottleKey\|REQUEST_DELAY_MS\|MCP_RL\|setKV" src/ --include="*.ts"
```

Expected: No matches except possibly in `src/auth/discogs.ts` (which has its own simple throttle for auth requests — intentionally left alone since auth requests are rare and don't need DO coordination).

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: clean up orphaned throttle references"
```
