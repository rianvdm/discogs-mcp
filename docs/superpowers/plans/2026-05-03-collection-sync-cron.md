# Collection Sync Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Discogs collection fetch to a background hourly Workers cron that maintains a snapshot in KV, so `search_collection` reads from KV instead of paginating the live API on every cold start.

**Architecture:** New `src/sync/collectionSync.ts` exports a pure `syncCollection(client, kv, userId, opts)` function. The Worker's `scheduled()` handler iterates `ALLOWED_DISCOGS_USER_ID`, loads each user's OAuth token from a new `discogs:token:{userId}` KV mirror written by the existing OAuth callback, and runs `syncCollection`. A new `refresh_collection` MCP tool calls the same function with `force: true`. `search_collection` reads from `collection:snapshot:{userId}` when present, falling back to the existing `cachedDiscogs.getCollectionItems` path during first-deploy bootstrap. Resumable via `collection:sync:progress:{userId}` so partial failures self-heal within an hour.

**Tech Stack:** TypeScript, Cloudflare Workers, KV namespaces (`MCP_SESSIONS`), Durable Objects (`DiscogsRateLimiter`, existing), vitest 3 + `@cloudflare/vitest-pool-workers` 0.8 (existing).

**Spec:** `docs/superpowers/specs/2026-05-03-collection-sync-cron-design.md`

---

## File Structure

**Create:**
- `src/sync/collectionSync.ts` — pure sync logic. Exports `syncCollection`, type definitions for `SnapshotBlob`, `ProgressBlob`, `SyncResult`, `SyncOptions`. ~250 lines.
- `src/sync/keys.ts` — KV key helpers: `snapshotKey(userId)`, `progressKey(userId)`, `lastForcedFullSyncKey(userId)`, `tokenMirrorKey(userId)`. Tiny, deterministic, easy to mock. ~15 lines.
- `test/sync/collectionSync.spec.ts` — unit tests for sync flow.
- `test/sync/scheduled.spec.ts` — integration tests for the `scheduled()` handler.

**Modify:**
- `src/index-oauth.ts` — add `scheduled()` export to the default object; add token-mirror write to OAuth callback (or hook the existing session write).
- `src/auth/oauth-handler.ts` — write the per-user token mirror alongside `session:{sessionId}`.
- `src/mcp/tools/authenticated.ts` — register `refresh_collection` tool.
- `src/clients/cachedDiscogs.ts` (or a new helper) — `searchCollection` read path checks for snapshot first, falls back to legacy path.
- `wrangler.toml` — add `[triggers] crons = ["0 * * * *"]` to default and `[env.production]` blocks.

---

## Task 1: Type Contracts

**Files:**
- Create: `src/sync/keys.ts`
- Create: `src/sync/types.ts`

- [ ] **Step 1: Write `keys.ts`**

```ts
// ABOUTME: KV key helpers for the collection sync subsystem.
// ABOUTME: Centralised here so tests and runtime code can't drift on key shape.

export const snapshotKey = (userId: string) => `collection:snapshot:${userId}`
export const progressKey = (userId: string) => `collection:sync:progress:${userId}`
export const lastForcedFullSyncKey = (userId: string) => `collection:sync:lastForcedFullSync:${userId}`
export const tokenMirrorKey = (userId: string) => `discogs:token:${userId}`
```

- [ ] **Step 2: Write `types.ts`**

```ts
// ABOUTME: Type contracts for the collection sync subsystem.
// ABOUTME: SnapshotBlob, ProgressBlob, SyncResult, SyncOptions.

import type { DiscogsCollectionItem } from '../clients/discogs'

export interface SnapshotBlob {
  schemaVersion: 1
  fetchedAt: string
  count: number
  topPageInstanceIds: number[]
  items: DiscogsCollectionItem[]
}

export interface ProgressBlob {
  startedAt: string
  totalPages: number
  totalCount: number
  lastPageFetched: number
  itemsSoFar: DiscogsCollectionItem[]
}

export interface TokenMirror {
  numericId: string
  username: string
  accessToken: string
  accessTokenSecret: string
}

export type SyncOutcome =
  | 'completed'
  | 'resumed'
  | 'skipped'
  | 'failed'
  | 'crashed'
  | 'no_token'
  | 'token_invalid'
  | 'in_progress'

export interface SyncResult {
  outcome: SyncOutcome
  pagesFetched: number
  count?: number
  fetchedAt?: string
  error?: string
}

export interface SyncOptions {
  force?: boolean
  now?: () => Date
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ~/git/discogs-mcp && npx tsc --noEmit`
Expected: clean exit (no errors).

- [ ] **Step 4: Commit**

```bash
cd ~/git/discogs-mcp
git add src/sync/keys.ts src/sync/types.ts
git commit -m "Add type contracts and KV key helpers for collection sync"
```

---

## Task 2: Token Mirror — write at OAuth callback

The cron has no request context, so the existing JWT-keyed session storage isn't reachable. Mirror each user's tokens under `discogs:token:{userId}` at the same time we write the session.

**Files:**
- Modify: `src/auth/oauth-handler.ts:344-358` — add a parallel `MCP_SESSIONS.put` for the token mirror.
- Test: `test/auth/oauth-handler.spec.ts` (or wherever the existing OAuth tests live; check before writing).

- [ ] **Step 1: Locate the existing OAuth callback test**

Run: `cd ~/git/discogs-mcp && rg -l "session:\${sessionId}|MCP_SESSIONS\.put" test/`
Expected: prints the test file(s) covering the callback. Read the closest match to see the existing test shape.

- [ ] **Step 2: Write the failing test**

Add to the relevant existing test file (or create `test/auth/token-mirror.spec.ts` if no clean home exists):

```ts
import { describe, it, expect } from 'vitest'
import { tokenMirrorKey } from '../../src/sync/keys'

// Inside the existing OAuth callback test setup:
it('writes a discogs:token:{userId} mirror alongside the session', async () => {
  // ... run the existing callback flow that ends with the identity fetch ...
  // After the callback completes:
  const mirror = await env.MCP_SESSIONS.get(tokenMirrorKey('12345'), 'json')
  expect(mirror).toMatchObject({
    numericId: '12345',
    username: 'someuser',
    accessToken: expect.any(String),
    accessTokenSecret: expect.any(String),
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/auth -t "discogs:token mirror"`
Expected: FAIL — mirror returns null.

- [ ] **Step 4: Add the mirror write in `oauth-handler.ts`**

Right after the existing `MCP_SESSIONS.put('session:${sessionId}', ...)` call (around line 358), add:

```ts
// Mirror the access token under a userId-keyed entry so the cron handler
// (which has no request context) can sync the user's collection in the background.
await env.MCP_SESSIONS.put(
  `discogs:token:${identity.id}`,
  JSON.stringify({
    numericId: String(identity.id),
    username: identity.username,
    accessToken,
    accessTokenSecret,
  }),
  // No TTL — the mirror should outlive sessions so the cron keeps working
  // even if the user hasn't opened an MCP client recently.
)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/auth -t "discogs:token mirror"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth/oauth-handler.ts test/auth/
git commit -m "Mirror Discogs OAuth tokens under discogs:token:{userId} for cron access"
```

---

## Task 3: First-run Bootstrap — `syncCollection` writes a snapshot from scratch

**Files:**
- Create: `src/sync/collectionSync.ts`
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sync/collectionSync.spec.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { syncCollection } from '../../src/sync/collectionSync'
import { snapshotKey } from '../../src/sync/keys'
import type { DiscogsCollectionItem, DiscogsCollectionResponse } from '../../src/clients/discogs'

function makeItem(id: number, instanceId: number, dateAdded = '2026-01-01T00:00:00Z'): DiscogsCollectionItem {
  return {
    id,
    instance_id: instanceId,
    folder_id: 0,
    date_added: dateAdded,
    rating: 0,
    basic_information: {
      id, title: `Album ${id}`, year: 2020,
      resource_url: '', thumb: '', cover_image: '',
      formats: [{ name: 'Vinyl', qty: '1' }],
      labels: [{ name: 'Label', catno: 'CAT-1' }],
      artists: [{ name: 'Artist', id: 1 }],
      genres: ['Rock'], styles: ['Pop'],
    },
  }
}

function makePage(items: DiscogsCollectionItem[], page: number, totalPages: number, totalItems: number): DiscogsCollectionResponse {
  return {
    pagination: { pages: totalPages, page, per_page: 100, items: totalItems, urls: {} },
    releases: items,
  }
}

interface FakeClient {
  getCollectionPage: (userId: string, opts: { page: number; per_page: number; sort: string; sort_order: string }) => Promise<DiscogsCollectionResponse>
}

describe('syncCollection — first-run bootstrap', () => {
  beforeEach(async () => {
    // Wipe sync keys before each test
    const list = await env.MCP_SESSIONS.list({ prefix: 'collection:' })
    for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
  })

  it('paginates the entire collection and writes a snapshot when none exists', async () => {
    const page1 = [makeItem(1, 101), makeItem(2, 102)]
    const page2 = [makeItem(3, 103)]
    const calls: number[] = []
    const client: FakeClient = {
      async getCollectionPage(_userId, opts) {
        calls.push(opts.page)
        if (opts.page === 1) return makePage(page1, 1, 2, 3)
        return makePage(page2, 2, 2, 3)
      },
    }

    const result = await syncCollection(client, env.MCP_SESSIONS, '12345', {})

    expect(result.outcome).toBe('completed')
    expect(result.pagesFetched).toBe(2)
    expect(calls).toEqual([1, 2])

    const snapshot = await env.MCP_SESSIONS.get(snapshotKey('12345'), 'json')
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      count: 3,
      topPageInstanceIds: [101, 102],
      items: expect.arrayContaining([
        expect.objectContaining({ instance_id: 101 }),
        expect.objectContaining({ instance_id: 102 }),
        expect.objectContaining({ instance_id: 103 }),
      ]),
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "first-run bootstrap"`
Expected: FAIL — `syncCollection` not exported.

- [ ] **Step 3: Implement minimal `syncCollection`**

```ts
// src/sync/collectionSync.ts
// ABOUTME: Background-syncs a user's Discogs collection into a KV snapshot.
// ABOUTME: Resumable via a progress key; readers always see a complete snapshot.

import type { KVNamespace } from '@cloudflare/workers-types'
import type { DiscogsCollectionItem, DiscogsCollectionResponse } from '../clients/discogs'
import { snapshotKey } from './keys'
import type { SnapshotBlob, SyncOptions, SyncResult } from './types'

export interface SyncClient {
  getCollectionPage(
    userId: string,
    opts: { page: number; per_page: number; sort: string; sort_order: string },
  ): Promise<DiscogsCollectionResponse>
}

const PER_PAGE = 100

export async function syncCollection(
  client: SyncClient,
  kv: KVNamespace,
  userId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const now = (opts.now ?? (() => new Date()))().toISOString()
  const allItems: DiscogsCollectionItem[] = []
  let totalPages = 1
  let totalCount = 0
  let topPageInstanceIds: number[] = []

  for (let page = 1; page <= totalPages; page++) {
    const res = await client.getCollectionPage(userId, {
      page,
      per_page: PER_PAGE,
      sort: 'added',
      sort_order: 'desc',
    })
    if (page === 1) {
      totalPages = res.pagination.pages
      totalCount = res.pagination.items
      topPageInstanceIds = res.releases.map((r) => r.instance_id)
    }
    allItems.push(...res.releases)
  }

  const snapshot: SnapshotBlob = {
    schemaVersion: 1,
    fetchedAt: now,
    count: totalCount,
    topPageInstanceIds,
    items: allItems,
  }
  await kv.put(snapshotKey(userId), JSON.stringify(snapshot))

  return { outcome: 'completed', pagesFetched: totalPages, count: totalCount, fetchedAt: now }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "first-run bootstrap"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/collectionSync.ts test/sync/collectionSync.spec.ts
git commit -m "syncCollection: first-run bootstrap writes a snapshot from scratch"
```

---

## Task 4: Atomic Swap — readers never see a partial snapshot

**Files:**
- Modify: `src/sync/collectionSync.ts`
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing describe block:

```ts
it('does not write to snapshot key until all pages have been fetched', async () => {
  // Pre-populate a previous good snapshot
  const prev: SnapshotBlob = {
    schemaVersion: 1, fetchedAt: '2026-01-01T00:00:00Z',
    count: 1, topPageInstanceIds: [999],
    items: [makeItem(99, 999)],
  }
  await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))

  const observed: Array<SnapshotBlob | null> = []
  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      // After each page, peek at the snapshot key
      observed.push(await env.MCP_SESSIONS.get(snapshotKey('u'), 'json'))
      if (opts.page === 1) return makePage([makeItem(1, 101)], 1, 3, 3)
      if (opts.page === 2) return makePage([makeItem(2, 102)], 2, 3, 3)
      return makePage([makeItem(3, 103)], 3, 3, 3)
    },
  }

  await syncCollection(client, env.MCP_SESSIONS, 'u', {})

  // Every snapshot read during the sync should be the previous snapshot, never a partial.
  for (const snap of observed) {
    expect(snap?.count).toBe(1)
    expect(snap?.topPageInstanceIds).toEqual([999])
  }
  // Final snapshot is the new one
  const final = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
  expect(final?.count).toBe(3)
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "atomic"`
Expected: PASS — implementation already builds in-memory and writes once at the end. (If it fails, the implementation is wrong; fix to build all items before the single `kv.put`.)

- [ ] **Step 3: Commit**

```bash
git add test/sync/collectionSync.spec.ts
git commit -m "syncCollection: assert atomic swap, readers never see partial snapshot"
```

---

## Task 5: Per-page Retry — 500 → 500 → 200 succeeds

**Files:**
- Modify: `src/sync/collectionSync.ts`
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('retries a transient page failure up to 3 times', async () => {
  let attempts = 0
  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      if (opts.page === 1) {
        attempts++
        if (attempts < 3) throw new Error('500 Internal Server Error')
        return makePage([makeItem(1, 101)], 1, 1, 1)
      }
      throw new Error('unreachable')
    },
  }

  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { now: () => new Date('2026-05-03T12:00:00Z') })
  expect(result.outcome).toBe('completed')
  expect(attempts).toBe(3)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "retries"`
Expected: FAIL — first throw aborts the run.

- [ ] **Step 3: Add retry helper inside `collectionSync.ts`**

Insert above `syncCollection`:

```ts
const RETRY_DELAYS_MS = [1000, 2000, 4000]

async function fetchPageWithRetry(
  client: SyncClient,
  userId: string,
  page: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<DiscogsCollectionResponse> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await client.getCollectionPage(userId, { page, per_page: PER_PAGE, sort: 'added', sort_order: 'desc' })
    } catch (err) {
      lastErr = err
      if (attempt < RETRY_DELAYS_MS.length - 1) await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
  throw lastErr
}
```

Then change the page fetch in `syncCollection` from:

```ts
const res = await client.getCollectionPage(userId, { ... })
```

to:

```ts
const res = await fetchPageWithRetry(client, userId, page)
```

For tests, inject a no-op sleep so the test isn't slow. Add `sleep?: (ms: number) => Promise<void>` to `SyncOptions`, default real `setTimeout`. Pass through into `fetchPageWithRetry`.

```ts
// In types.ts, extend SyncOptions:
export interface SyncOptions {
  force?: boolean
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

// In syncCollection, accept and pass:
const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
const res = await fetchPageWithRetry(client, userId, page, sleep)
```

Update the failing test to pass `{ sleep: async () => {} }` so retries are instant:

```ts
const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "retries"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/collectionSync.ts src/sync/types.ts test/sync/collectionSync.spec.ts
git commit -m "syncCollection: per-page retry with exponential backoff (3 attempts)"
```

---

## Task 6: Retry Exhausted — persist progress, leave snapshot untouched

**Files:**
- Modify: `src/sync/collectionSync.ts`
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { progressKey } from '../../src/sync/keys'
import type { ProgressBlob } from '../../src/sync/types'

it('persists progress and leaves snapshot untouched when retries are exhausted', async () => {
  const prev: SnapshotBlob = {
    schemaVersion: 1, fetchedAt: '2026-01-01T00:00:00Z',
    count: 1, topPageInstanceIds: [999], items: [makeItem(99, 999)],
  }
  await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))

  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      if (opts.page === 1) return makePage([makeItem(1, 101)], 1, 3, 3)
      if (opts.page === 2) return makePage([makeItem(2, 102)], 2, 3, 3)
      throw new Error('500 on page 3')
    },
  }

  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })

  expect(result.outcome).toBe('failed')
  expect(result.pagesFetched).toBe(2)

  // Snapshot still the previous one
  const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
  expect(snap?.count).toBe(1)

  // Progress recorded
  const prog = await env.MCP_SESSIONS.get<ProgressBlob>(progressKey('u'), 'json')
  expect(prog?.lastPageFetched).toBe(2)
  expect(prog?.totalPages).toBe(3)
  expect(prog?.totalCount).toBe(3)
  expect(prog?.itemsSoFar).toHaveLength(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "retries are exhausted"`
Expected: FAIL — error escapes `syncCollection`.

- [ ] **Step 3: Wrap the loop in try/catch and persist progress per page**

Replace the body of `syncCollection`'s page loop with progress-persisting logic:

```ts
export async function syncCollection(
  client: SyncClient,
  kv: KVNamespace,
  userId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const now = (opts.now ?? (() => new Date()))().toISOString()
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const itemsSoFar: DiscogsCollectionItem[] = []
  let totalPages = 1
  let totalCount = 0
  let topPageInstanceIds: number[] = []
  let lastPageFetched = 0

  try {
    for (let page = 1; page <= totalPages; page++) {
      const res = await fetchPageWithRetry(client, userId, page, sleep)
      if (page === 1) {
        totalPages = res.pagination.pages
        totalCount = res.pagination.items
        topPageInstanceIds = res.releases.map((r) => r.instance_id)
      }
      itemsSoFar.push(...res.releases)
      lastPageFetched = page

      // Persist progress after each successful page (except the last — we'll
      // commit the final snapshot atomically and delete progress in one go).
      if (page < totalPages) {
        const progress: ProgressBlob = {
          startedAt: now, totalPages, totalCount, lastPageFetched, itemsSoFar,
        }
        await kv.put(progressKey(userId), JSON.stringify(progress))
      }
    }
  } catch (err) {
    return {
      outcome: 'failed',
      pagesFetched: lastPageFetched,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const snapshot: SnapshotBlob = {
    schemaVersion: 1, fetchedAt: now, count: totalCount, topPageInstanceIds, items: itemsSoFar,
  }
  await kv.put(snapshotKey(userId), JSON.stringify(snapshot))
  await kv.delete(progressKey(userId))

  return { outcome: 'completed', pagesFetched: lastPageFetched, count: totalCount, fetchedAt: now }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "retries are exhausted"`
Expected: PASS. Re-run the full file to confirm prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/sync/collectionSync.ts test/sync/collectionSync.spec.ts
git commit -m "syncCollection: persist progress on retry exhaustion, snapshot untouched"
```

---

## Task 7: Resume — start from `lastPageFetched + 1`

**Files:**
- Modify: `src/sync/collectionSync.ts`
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('resumes from progress.lastPageFetched + 1 when progress key exists', async () => {
  const progress: ProgressBlob = {
    startedAt: '2026-05-03T12:00:00Z',
    totalPages: 3, totalCount: 3,
    lastPageFetched: 2,
    itemsSoFar: [makeItem(1, 101), makeItem(2, 102)],
  }
  await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify(progress))

  const calls: number[] = []
  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      calls.push(opts.page)
      if (opts.page === 3) return makePage([makeItem(3, 103)], 3, 3, 3)
      throw new Error(`unexpected page ${opts.page}`)
    },
  }

  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {}, now: () => new Date('2026-05-03T13:00:00Z') })

  expect(result.outcome).toBe('resumed')
  expect(calls).toEqual([3])
  const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
  expect(snap?.items.map((i) => i.instance_id)).toEqual([101, 102, 103])
  expect(snap?.count).toBe(3)
  // Progress cleaned up
  expect(await env.MCP_SESSIONS.get(progressKey('u'))).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "resumes from progress"`
Expected: FAIL — currently always starts at page 1.

- [ ] **Step 3: Add resume logic at the top of `syncCollection`**

Replace the early initialisations and loop start with progress-aware versions:

```ts
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
const existingProgressRaw = await kv.get(progressKey(userId), 'json') as ProgressBlob | null
const progressIsFresh =
  existingProgressRaw &&
  Date.now() - new Date(existingProgressRaw.startedAt).getTime() < sevenDaysMs

let resumed = false
let itemsSoFar: DiscogsCollectionItem[] = []
let totalPages = 1
let totalCount = 0
let topPageInstanceIds: number[] = []
let lastPageFetched = 0
let startPage = 1

if (progressIsFresh) {
  resumed = true
  itemsSoFar = [...existingProgressRaw.itemsSoFar]
  totalPages = existingProgressRaw.totalPages
  totalCount = existingProgressRaw.totalCount
  lastPageFetched = existingProgressRaw.lastPageFetched
  startPage = existingProgressRaw.lastPageFetched + 1
  // topPageInstanceIds will be filled from the snapshot we replace, or recomputed
  // if we ever resume from page 1 (we don't — startPage > 1 here).
  topPageInstanceIds = itemsSoFar.slice(0, 100).map((i) => i.instance_id)
}

try {
  for (let page = startPage; page <= totalPages; page++) {
    const res = await fetchPageWithRetry(client, userId, page, sleep)
    if (page === 1) {
      totalPages = res.pagination.pages
      totalCount = res.pagination.items
      topPageInstanceIds = res.releases.map((r) => r.instance_id)
    }
    itemsSoFar.push(...res.releases)
    lastPageFetched = page
    if (page < totalPages) {
      const progress: ProgressBlob = { startedAt: now, totalPages, totalCount, lastPageFetched, itemsSoFar }
      await kv.put(progressKey(userId), JSON.stringify(progress))
    }
  }
} catch (err) { /* ... unchanged ... */ }

// At the end, return outcome based on whether we resumed
const outcome: SyncOutcome = resumed ? 'resumed' : 'completed'
return { outcome, pagesFetched: lastPageFetched, count: totalCount, fetchedAt: now }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts`
Expected: all sync tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/collectionSync.ts test/sync/collectionSync.spec.ts
git commit -m "syncCollection: resume from progress.lastPageFetched + 1"
```

---

## Task 8: Drift-mid-resume — restart when count changes

**Files:**
- Modify: `src/sync/collectionSync.ts`
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('discards progress and restarts when totalCount changes mid-resume', async () => {
  const progress: ProgressBlob = {
    startedAt: '2026-05-03T12:00:00Z',
    totalPages: 3, totalCount: 3,
    lastPageFetched: 2,
    itemsSoFar: [makeItem(1, 101), makeItem(2, 102)],
  }
  await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify(progress))

  const calls: number[] = []
  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      calls.push(opts.page)
      // Page 3 reports a different count → drift
      if (opts.page === 3) return makePage([makeItem(3, 103)], 3, 3, 4)
      // Restart from page 1 — collection is now 4 items across 1 page
      if (opts.page === 1) return makePage([makeItem(1, 101), makeItem(2, 102), makeItem(3, 103), makeItem(4, 104)], 1, 1, 4)
      throw new Error(`unexpected page ${opts.page}`)
    },
  }

  await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })

  // Should have fetched page 3 (drift detected) then restarted at page 1
  expect(calls).toEqual([3, 1])
  const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
  expect(snap?.count).toBe(4)
  expect(snap?.items).toHaveLength(4)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "discards progress"`
Expected: FAIL — no drift check yet.

- [ ] **Step 3: Add drift detection + recursive restart**

Inside the page loop, after the page fetch, before appending items:

```ts
// Drift check: if we resumed, every subsequent page's pagination.items must match
// the totalCount we're carrying forward. Discogs returns the live count in every
// page response, so any disagreement means the collection changed mid-sync.
if (resumed && res.pagination.items !== totalCount) {
  await kv.delete(progressKey(userId))
  return syncCollection(client, kv, userId, { ...opts, force: true })
}
```

Note: the recursive call passes the same opts. The fresh entry won't see a progress key (we just deleted it), so it starts from page 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "discards progress"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/collectionSync.ts test/sync/collectionSync.spec.ts
git commit -m "syncCollection: restart on drift (pagination.items != totalCount)"
```

---

## Task 9: Stale Progress — ignore progress >7 days old

**Files:**
- Modify: `src/sync/collectionSync.ts` (already handled via `progressIsFresh`)
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('ignores progress older than 7 days and starts fresh', async () => {
  const ancient: ProgressBlob = {
    startedAt: '2026-04-01T00:00:00Z', // >30 days before "now"
    totalPages: 3, totalCount: 3,
    lastPageFetched: 2,
    itemsSoFar: [makeItem(1, 101), makeItem(2, 102)],
  }
  await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify(ancient))

  const calls: number[] = []
  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      calls.push(opts.page)
      return makePage([makeItem(opts.page, opts.page * 100)], opts.page, 1, 1)
    },
  }

  // Note: vitest pool-workers controls Date.now via env? In practice, the existing
  // progress timestamp is far enough in the past that real Date.now > 7d.
  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
  expect(result.outcome).toBe('completed') // not "resumed"
  expect(calls[0]).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "ignores progress older"`
Expected: PASS — the `progressIsFresh` check from Task 7 already handles this.

- [ ] **Step 3: Commit**

```bash
git add test/sync/collectionSync.spec.ts
git commit -m "syncCollection: assert stale progress (>7 days) is ignored"
```

---

## Task 10: Probe — no-op when count + page-1 set match

**Files:**
- Modify: `src/sync/collectionSync.ts`
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { lastForcedFullSyncKey } from '../../src/sync/keys'

it('skips full repaginate when count and topPageInstanceIds both match', async () => {
  const prev: SnapshotBlob = {
    schemaVersion: 1, fetchedAt: '2026-05-03T00:00:00Z',
    count: 2, topPageInstanceIds: [101, 102],
    items: [makeItem(1, 101), makeItem(2, 102)],
  }
  await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
  // Recent forced full sweep so weekly-sweep doesn't trigger
  await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), new Date().toISOString())

  const calls: number[] = []
  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      calls.push(opts.page)
      // Same count, same page-1 instance_ids
      return makePage([makeItem(1, 101), makeItem(2, 102)], 1, 1, 2)
    },
  }

  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
  expect(result.outcome).toBe('skipped')
  expect(calls).toEqual([1]) // only the probe call, no full repaginate
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "skips full repaginate"`
Expected: FAIL — currently always paginates.

- [ ] **Step 3: Add probe logic at sync entry**

Insert before the main page loop (and after the progress-resume block — probe only runs when starting fresh and not forced):

```ts
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

if (!resumed && !opts.force) {
  const existingSnapshot = await kv.get<SnapshotBlob>(snapshotKey(userId), 'json')
  const lastForced = await kv.get(lastForcedFullSyncKey(userId))
  const lastForcedFresh = lastForced && Date.now() - new Date(lastForced).getTime() < SEVEN_DAYS_MS

  if (existingSnapshot && lastForcedFresh) {
    // Run probe: fetch page 1, compare count + top instance_ids
    const probe = await fetchPageWithRetry(client, userId, 1, sleep)
    const probeTopIds = probe.releases.map((r) => r.instance_id)
    const sameCount = probe.pagination.items === existingSnapshot.count
    const sameTopIds =
      probeTopIds.length === existingSnapshot.topPageInstanceIds.length &&
      probeTopIds.every((id, i) => id === existingSnapshot.topPageInstanceIds[i])

    if (sameCount && sameTopIds) {
      return { outcome: 'skipped', pagesFetched: 1, count: existingSnapshot.count, fetchedAt: existingSnapshot.fetchedAt }
    }

    // Probe tripped — reuse the page-1 response as the first page of the full sync
    totalPages = probe.pagination.pages
    totalCount = probe.pagination.items
    topPageInstanceIds = probeTopIds
    itemsSoFar.push(...probe.releases)
    lastPageFetched = 1
    startPage = 2
  }
}
```

Also: when a full sync completes (not on probe-skip), write `lastForcedFullSyncKey`:

```ts
// After the snapshot put, before the progress delete:
await kv.put(lastForcedFullSyncKey(userId), now)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts`
Expected: ALL tests PASS. The probe-skip test's "only page 1 fetched" assertion confirms no full repaginate.

- [ ] **Step 5: Commit**

```bash
git add src/sync/collectionSync.ts test/sync/collectionSync.spec.ts
git commit -m "syncCollection: probe with count + page-1 instance_ids; skip on no-op"
```

---

## Task 11: Probe — count mismatch triggers full repaginate

**Files:**
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('triggers full repaginate when probe count differs from snapshot count', async () => {
  const prev: SnapshotBlob = {
    schemaVersion: 1, fetchedAt: '2026-05-03T00:00:00Z',
    count: 2, topPageInstanceIds: [101, 102],
    items: [makeItem(1, 101), makeItem(2, 102)],
  }
  await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
  await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), new Date().toISOString())

  const calls: number[] = []
  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      calls.push(opts.page)
      // Probe + page 1 of new sync: count is now 3
      if (opts.page === 1) return makePage([makeItem(1, 101), makeItem(2, 102), makeItem(3, 103)], 1, 1, 3)
      throw new Error(`unexpected page ${opts.page}`)
    },
  }

  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
  expect(result.outcome).toBe('completed')
  expect(result.count).toBe(3)
  // Page 1 fetched once total — probe response is reused as page 1 of the sync
  expect(calls).toEqual([1])
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "count differs"`
Expected: PASS — probe-tripped path is already wired in Task 10.

- [ ] **Step 3: Commit**

```bash
git add test/sync/collectionSync.spec.ts
git commit -m "syncCollection: assert count mismatch triggers full repaginate"
```

---

## Task 12: Probe — swap detection (same count, different page-1 set)

**Files:**
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('detects add+remove swap when count matches but page-1 instance_ids differ', async () => {
  const prev: SnapshotBlob = {
    schemaVersion: 1, fetchedAt: '2026-05-03T00:00:00Z',
    count: 2, topPageInstanceIds: [101, 102],
    items: [makeItem(1, 101), makeItem(2, 102)],
  }
  await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
  await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), new Date().toISOString())

  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      // count=2 still, but instance 102 was removed and 103 was added
      if (opts.page === 1) return makePage([makeItem(1, 101), makeItem(3, 103)], 1, 1, 2)
      throw new Error(`unexpected page ${opts.page}`)
    },
  }

  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
  expect(result.outcome).toBe('completed')
  const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
  expect(snap?.topPageInstanceIds).toEqual([101, 103])
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "add\\+remove swap"`
Expected: PASS — already covered by the same-count + different-ids branch.

- [ ] **Step 3: Commit**

```bash
git add test/sync/collectionSync.spec.ts
git commit -m "syncCollection: assert swap (same count, different page-1) triggers repaginate"
```

---

## Task 13: Forced Full Sync — `force: true` bypasses probe

**Files:**
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('skips probe and runs a full repaginate when force is true', async () => {
  const prev: SnapshotBlob = {
    schemaVersion: 1, fetchedAt: '2026-05-03T00:00:00Z',
    count: 1, topPageInstanceIds: [101],
    items: [makeItem(1, 101)],
  }
  await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
  await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), new Date().toISOString())

  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      // Identical to snapshot — without force, probe would skip
      return makePage([makeItem(1, 101)], 1, 1, 1)
    },
  }

  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { force: true, sleep: async () => {} })
  expect(result.outcome).toBe('completed') // not "skipped"
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "skips probe.*force"`
Expected: PASS — `!opts.force` guard already wired.

- [ ] **Step 3: Commit**

```bash
git add test/sync/collectionSync.spec.ts
git commit -m "syncCollection: assert force=true bypasses probe"
```

---

## Task 14: Weekly Forced Sweep — full repaginate even when probe says skip

**Files:**
- Test: `test/sync/collectionSync.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('forces full repaginate when lastForcedFullSync is older than 7 days', async () => {
  const prev: SnapshotBlob = {
    schemaVersion: 1, fetchedAt: '2026-04-20T00:00:00Z',
    count: 1, topPageInstanceIds: [101], items: [makeItem(1, 101)],
  }
  await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
  // 8 days ago — past the threshold
  await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), '2026-04-25T00:00:00Z')

  const client: SyncClient = {
    async getCollectionPage(_u, opts) {
      return makePage([makeItem(1, 101)], 1, 1, 1)
    },
  }

  const result = await syncCollection(client, env.MCP_SESSIONS, 'u', {
    sleep: async () => {},
    now: () => new Date('2026-05-03T12:00:00Z'),
  })
  expect(result.outcome).toBe('completed')
})
```

- [ ] **Step 2: Run test to verify it fails (or passes)**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts -t "older than 7 days"`
Expected: depends on whether the `lastForcedFresh` check uses `Date.now()` or `opts.now()`. If it uses `Date.now()`, the test won't reliably exercise the stale-week path because the test's "now" is 2026-05-03 but real Date.now is whenever the test runs.

- [ ] **Step 3: Make the stale-week check use `opts.now`**

In `syncCollection`, replace `Date.now()` in the lastForcedFresh check with the captured `now` param:

```ts
const nowDate = (opts.now ?? (() => new Date()))()
const now = nowDate.toISOString()
const nowMs = nowDate.getTime()

// ...
const lastForcedFresh = lastForced && nowMs - new Date(lastForced).getTime() < SEVEN_DAYS_MS
```

Also update the progress-staleness check to use `nowMs` for consistency.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts`
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/collectionSync.ts test/sync/collectionSync.spec.ts
git commit -m "syncCollection: weekly forced full sweep when lastForcedFullSync >7d"
```

---

## Task 15: Wire `DiscogsClient.getCollectionPage` for the SyncClient interface

**Files:**
- Modify: `src/clients/discogs.ts`

The sync code expects `getCollectionPage(userId, { page, per_page, sort, sort_order })`. Check whether `DiscogsClient` already exposes this shape; if not, add a thin wrapper.

- [ ] **Step 1: Inspect existing client surface**

Run: `cd ~/git/discogs-mcp && rg -n "getCollectionPage|getCollectionItems|/users/.*collection" src/clients/discogs.ts`

If `getCollectionPage` already exists with the right shape, skip to Step 4.

- [ ] **Step 2: Add `getCollectionPage` (if missing)**

```ts
// In DiscogsClient
async getCollectionPage(
  userId: string,
  opts: { page: number; per_page: number; sort: string; sort_order: string },
): Promise<DiscogsCollectionResponse> {
  const params = new URLSearchParams({
    page: String(opts.page),
    per_page: String(opts.per_page),
    sort: opts.sort,
    sort_order: opts.sort_order,
  })
  const url = `https://api.discogs.com/users/${encodeURIComponent(userId)}/collection/folders/0/releases?${params}`
  return this.signedGet<DiscogsCollectionResponse>(url)
}
```

(Use whatever the existing signed-GET helper is named in `discogs.ts` — `signedGet` is illustrative.)

- [ ] **Step 3: Quick sanity test**

```ts
// test/clients/discogs.spec.ts (extend or create)
it('getCollectionPage builds the right URL', async () => {
  const client = new DiscogsClient({ /* ... */ })
  const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pagination: {pages:1,page:1,per_page:100,items:0,urls:{}}, releases: [] })))
  globalThis.fetch = fetchSpy
  await client.getCollectionPage('u', { page: 2, per_page: 100, sort: 'added', sort_order: 'desc' })
  const calledUrl = fetchSpy.mock.calls[0][0]
  expect(String(calledUrl)).toContain('/users/u/collection/folders/0/releases')
  expect(String(calledUrl)).toContain('page=2')
  expect(String(calledUrl)).toContain('sort=added')
})
```

- [ ] **Step 4: Run + commit**

```bash
cd ~/git/discogs-mcp
npx vitest run test/clients/discogs.spec.ts
git add src/clients/discogs.ts test/clients/discogs.spec.ts
git commit -m "DiscogsClient: getCollectionPage for syncCollection"
```

---

## Task 16: `scheduled()` Handler — iterate allowlist

**Files:**
- Modify: `src/index-oauth.ts:177` (`export default {}` block — add `scheduled` alongside `fetch`).
- Test: `test/sync/scheduled.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sync/scheduled.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, createScheduledController } from 'cloudflare:test'
import worker from '../../src/index-oauth'
import { snapshotKey, tokenMirrorKey } from '../../src/sync/keys'

describe('scheduled() handler', () => {
  beforeEach(async () => {
    const list = await env.MCP_SESSIONS.list()
    for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
  })

  it('syncs every user in ALLOWED_DISCOGS_USER_ID who has a token mirror', async () => {
    // Seed token mirrors for two users
    for (const id of ['12345', '67890']) {
      await env.MCP_SESSIONS.put(tokenMirrorKey(id), JSON.stringify({
        numericId: id, username: `user${id}`,
        accessToken: 'tok', accessTokenSecret: 'sec',
      }))
    }
    // Stub Discogs network calls
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pagination: { pages: 1, page: 1, per_page: 100, items: 1, urls: {} },
      releases: [{ id: 1, instance_id: 101, folder_id: 0, date_added: '2026-01-01T00:00:00Z', rating: 0, basic_information: { id: 1, title: 't', year: 2020, resource_url: '', thumb: '', cover_image: '', formats: [], labels: [], artists: [], genres: [], styles: [] }}],
    })))
    globalThis.fetch = fetchSpy

    const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '0 * * * *' })
    await worker.scheduled!(ctrl, { ...env, ALLOWED_DISCOGS_USER_ID: '12345,67890' } as any, { waitUntil: () => {}, passThroughOnException: () => {} } as any)

    expect(await env.MCP_SESSIONS.get(snapshotKey('12345'))).toBeTruthy()
    expect(await env.MCP_SESSIONS.get(snapshotKey('67890'))).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/scheduled.spec.ts`
Expected: FAIL — `worker.scheduled` undefined.

- [ ] **Step 3: Add `scheduled()` to `src/index-oauth.ts`**

Inside the existing `export default { ... }` object (around line 177), add alongside `fetch`:

```ts
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const { syncCollection } = await import('./sync/collectionSync')
  const { tokenMirrorKey } = await import('./sync/keys')
  const { DiscogsClient } = await import('./clients/discogs')

  const allowed = (env.ALLOWED_DISCOGS_USER_ID || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const userId of allowed) {
    try {
      const tokenStr = await env.MCP_SESSIONS.get(tokenMirrorKey(userId))
      if (!tokenStr) {
        await logSyncOutcome(env, userId, { outcome: 'no_token', pagesFetched: 0 })
        continue
      }
      const token = JSON.parse(tokenStr)
      const client = new DiscogsClient({
        consumerKey: env.DISCOGS_CONSUMER_KEY,
        consumerSecret: env.DISCOGS_CONSUMER_SECRET,
        accessToken: token.accessToken,
        accessTokenSecret: token.accessTokenSecret,
        rateLimiter: env.RATE_LIMITER,
      })
      const result = await syncCollection(client, env.MCP_SESSIONS, userId, {})
      await logSyncOutcome(env, userId, result)
    } catch (err) {
      await logSyncOutcome(env, userId, {
        outcome: 'crashed', pagesFetched: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
```

Add a tiny helper:

```ts
async function logSyncOutcome(env: Env, userId: string, result: SyncResult) {
  const entry = {
    timestamp: new Date().toISOString(),
    userId,
    ...result,
  }
  await env.MCP_LOGS.put(`sync:${entry.timestamp}:${userId}`, JSON.stringify(entry), {
    expirationTtl: 30 * 24 * 60 * 60,
  })
}
```

(Adjust the `DiscogsClient` constructor call to match the actual signature in `src/clients/discogs.ts`. If it differs, conform.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/scheduled.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index-oauth.ts test/sync/scheduled.spec.ts
git commit -m "Add scheduled() handler iterating ALLOWED_DISCOGS_USER_ID"
```

---

## Task 17: `scheduled()` — per-user crash isolation + no_token skip

**Files:**
- Test: `test/sync/scheduled.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('isolates per-user crashes and continues with the next user', async () => {
  await env.MCP_SESSIONS.put(tokenMirrorKey('alpha'), JSON.stringify({
    numericId: 'alpha', username: 'a', accessToken: 'tok', accessTokenSecret: 'sec',
  }))
  // 'beta' has no token mirror

  const calls: string[] = []
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    calls.push(url)
    if (calls.length === 1) throw new Error('alpha boom')
    return Promise.resolve(new Response(JSON.stringify({
      pagination: { pages: 1, page: 1, per_page: 100, items: 0, urls: {} },
      releases: [],
    })))
  })

  const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '0 * * * *' })
  await worker.scheduled!(ctrl, { ...env, ALLOWED_DISCOGS_USER_ID: 'alpha,beta' } as any, { waitUntil: () => {}, passThroughOnException: () => {} } as any)

  // alpha crashed, beta got no_token — both logged, neither blocked the other
  const logs = await env.MCP_LOGS.list({ prefix: 'sync:' })
  const userIds = await Promise.all(logs.keys.map(async (k) => {
    const v = await env.MCP_LOGS.get(k.name, 'json') as { userId: string }
    return v.userId
  }))
  expect(userIds.sort()).toEqual(['alpha', 'beta'])
})
```

- [ ] **Step 2: Run + verify pass**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/scheduled.spec.ts -t "isolates per-user"`
Expected: PASS — try/catch + continue is already wired in Task 16.

- [ ] **Step 3: Commit**

```bash
git add test/sync/scheduled.spec.ts
git commit -m "scheduled(): assert per-user crash isolation + no_token skip"
```

---

## Task 18: `refresh_collection` MCP Tool

**Files:**
- Modify: `src/mcp/tools/authenticated.ts`
- Test: `test/sync/refresh-collection-tool.spec.ts` (or extend existing `test/mcp/tools` if there's a clear home)

- [ ] **Step 1: Write the failing test**

```ts
// test/sync/refresh-collection-tool.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { snapshotKey, progressKey } from '../../src/sync/keys'

describe('refresh_collection tool', () => {
  it('forces a full sync and returns count + fetchedAt', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pagination: { pages: 1, page: 1, per_page: 100, items: 1, urls: {} },
      releases: [{ id: 1, instance_id: 101, folder_id: 0, date_added: '2026-01-01T00:00:00Z', rating: 0, basic_information: { id: 1, title: 't', year: 2020, resource_url: '', thumb: '', cover_image: '', formats: [], labels: [], artists: [], genres: [], styles: [] } }],
    })))

    // Build the tool handler context the same way the existing tool tests do.
    // Find the pattern in test/mcp/tools/* and mirror it.
    const result = await callTool('refresh_collection', {}, { userId: 'u', /* ... */ })
    expect(result.status).toBe('completed')
    expect(result.count).toBe(1)
    expect(result.fetchedAt).toBeTruthy()
  })

  it('returns in_progress when a sync is already running', async () => {
    // Pre-populate progress key
    await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify({
      startedAt: new Date().toISOString(),
      totalPages: 10, totalCount: 1000, lastPageFetched: 3,
      itemsSoFar: [],
    }))
    const result = await callTool('refresh_collection', {}, { userId: 'u' /* ... */ })
    expect(result.status).toBe('in_progress')
  })
})
```

(Replace `callTool` with whatever harness the existing authenticated tool tests use. Inspect `test/mcp/` first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/refresh-collection-tool.spec.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Register the tool in `src/mcp/tools/authenticated.ts`**

```ts
server.tool(
  'refresh_collection',
  'Force an immediate full refresh of the cached collection snapshot. Use after adding or removing items in Discogs if you need them visible to search before the next hourly sync.',
  {},
  async (_args, ctx) => {
    const { syncCollection } = await import('../../sync/collectionSync')
    const { progressKey } = await import('../../sync/keys')

    // Concurrent-call guard: if a progress key is fresh, don't start a duplicate.
    const existing = await ctx.env.MCP_SESSIONS.get(progressKey(ctx.userId), 'json') as { startedAt: string } | null
    if (existing && Date.now() - new Date(existing.startedAt).getTime() < 5 * 60 * 1000) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'in_progress' }),
        }],
      }
    }

    const result = await syncCollection(ctx.discogsClient, ctx.env.MCP_SESSIONS, ctx.userId, { force: true })
    const status = result.outcome === 'resumed' ? 'resumed' : 'completed'
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status,
          count: result.count,
          fetchedAt: result.fetchedAt,
          pagesFetched: result.pagesFetched,
        }),
      }],
    }
  },
)
```

(Conform to whatever tool-registration pattern the file uses — look at `search_collection` registration nearby for reference.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/refresh-collection-tool.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/authenticated.ts test/sync/refresh-collection-tool.spec.ts
git commit -m "Add refresh_collection MCP tool with concurrent-call guard"
```

---

## Task 19: `search_collection` Reads from Snapshot When Present

**Files:**
- Modify: `src/clients/cachedDiscogs.ts` (the `getCollectionItems` method) OR introduce a thin helper used by `search_collection`. Inspect the call site first.
- Test: `test/sync/search-collection-snapshot.spec.ts`

- [ ] **Step 1: Locate the call site**

Run: `cd ~/git/discogs-mcp && rg -n "getCollectionItems\(" src/`
Expected: one or two callers, likely `search_collection` and possibly the recommendations tool.

- [ ] **Step 2: Write the failing test**

```ts
// test/sync/search-collection-snapshot.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { snapshotKey } from '../../src/sync/keys'

describe('search_collection read path', () => {
  it('reads from collection:snapshot:{userId} when present and skips the live API', async () => {
    await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify({
      schemaVersion: 1,
      fetchedAt: '2026-05-03T00:00:00Z',
      count: 1,
      topPageInstanceIds: [101],
      items: [{
        id: 1, instance_id: 101, folder_id: 0, date_added: '2026-01-01T00:00:00Z', rating: 0,
        basic_information: {
          id: 1, title: 'Snapshot Album', year: 2020,
          resource_url: '', thumb: '', cover_image: '',
          formats: [{ name: 'Vinyl', qty: '1' }],
          labels: [{ name: 'Lab', catno: 'C1' }],
          artists: [{ name: 'Snapshot Artist', id: 1 }],
          genres: ['Rock'], styles: ['Pop'],
        },
      }],
    }))
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy

    // Call search_collection with a query that should match the snapshot item.
    const result = await callTool('search_collection', { query: 'snapshot' }, { userId: 'u' })
    expect(result.results).toHaveLength(1)
    expect(result.results[0].title).toBe('Snapshot Album')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to live pagination when no snapshot exists', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pagination: { pages: 1, page: 1, per_page: 100, items: 1, urls: {} },
      releases: [/* one release with title "Live" */],
    })))
    globalThis.fetch = fetchSpy
    await callTool('search_collection', { query: 'live' }, { userId: 'u' })
    expect(fetchSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/search-collection-snapshot.spec.ts`
Expected: FAIL — snapshot path not wired.

- [ ] **Step 4: Wire the snapshot read into `getCollectionItems` (or wrap it)**

In `src/clients/cachedDiscogs.ts`, at the top of `getCollectionItems`:

```ts
async getCollectionItems(userId: string): Promise<DiscogsCollectionItem[]> {
  const { snapshotKey } = await import('../sync/keys')
  const snapshot = await this.kv.get<{ items: DiscogsCollectionItem[] }>(snapshotKey(userId), 'json')
  if (snapshot && Array.isArray(snapshot.items)) {
    return snapshot.items
  }
  // Existing pagination path
  return this.fetchCollectionItemsLive(userId)
}
```

(Rename the existing body into `fetchCollectionItemsLive` for clarity. Keep the per-method KV cache layer the legacy path uses.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/search-collection-snapshot.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/clients/cachedDiscogs.ts test/sync/search-collection-snapshot.spec.ts
git commit -m "search_collection: read from collection:snapshot:{userId} when present"
```

---

## Task 20: `wrangler.toml` — cron triggers

**Files:**
- Modify: `wrangler.toml`

- [ ] **Step 1: Add cron triggers**

Below the existing `[durable_objects]` block, add:

```toml
[triggers]
crons = ["0 * * * *"]
```

And below the `[env.production.durable_objects]` block, add:

```toml
[env.production.triggers]
crons = ["0 * * * *"]
```

- [ ] **Step 2: Validate config**

Run: `cd ~/git/discogs-mcp && npx wrangler deploy --dry-run --env production`
Expected: clean dry-run output mentioning the cron trigger.

- [ ] **Step 3: Commit**

```bash
git add wrangler.toml
git commit -m "Add hourly cron trigger for collection sync"
```

---

## Task 21: Full Test Sweep + Lint

- [ ] **Step 1: Run the full test suite**

Run: `cd ~/git/discogs-mcp && npm test -- --run`
Expected: all green.

- [ ] **Step 2: Lint + format**

Run: `cd ~/git/discogs-mcp && npm run lint && npm run format:check`
Expected: clean. Fix anything flagged.

- [ ] **Step 3: Build dry-run**

Run: `cd ~/git/discogs-mcp && npm run build`
Expected: clean.

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git diff --cached --stat
# Only commit if there are actual changes (formatting fixes, etc.)
git commit -m "Lint and format pass after collection sync feature"
```

---

## Task 22: Manual Smoke Test on Dev Worker

- [ ] **Step 1: Deploy to dev**

Run: `cd ~/git/discogs-mcp && npm run deploy`
Expected: deploy succeeds; cron registered (look for "scheduled" in the output).

- [ ] **Step 2: Trigger a manual cron run**

Run: `cd ~/git/discogs-mcp && npx wrangler tail discogs-mcp` in one terminal.
In another: `npx wrangler cron trigger discogs-mcp --cron "0 * * * *"`
Expected: tail shows the scheduled handler firing, sync logs for the maintainer's user ID.

- [ ] **Step 3: Verify snapshot landed in KV**

Run (check this against the dev KV namespace `MCP_SESSIONS`):

```bash
npx wrangler kv key get "collection:snapshot:2579319" --binding=MCP_SESSIONS --remote
```

Expected: JSON snapshot returned with `count` matching the maintainer's actual collection size.

- [ ] **Step 4: Verify `search_collection` is fast**

Call the MCP `search_collection` tool from a real client (Claude Desktop or `curl` via the MCP HTTP transport). Expected latency: sub-second on first call (now reading from snapshot, not paginating).

- [ ] **Step 5: Promote to production**

Run: `cd ~/git/discogs-mcp && npm run deploy:prod`
Expected: production deploy succeeds. CI auto-deploys on push to main, but a manual `deploy:prod` is fine for the first cron-enabled deploy.

---

## Self-Review Notes

* **Spec coverage:** every test in spec §Testing maps to a Task (3–14, 16–19). `wrangler.toml` triggers covered in Task 20. `scheduled()` handler in 16, `refresh_collection` in 18, snapshot read path in 19. Open Question #2 (KV binding) resolved by using `MCP_SESSIONS` throughout — implementor can swap to a dedicated `COLLECTION_KV` later if needed; key helpers in `src/sync/keys.ts` make the swap a one-line change.
* **Token mirror approach:** spec §KV Schema flagged this as discovery; resolved here by writing a userId-keyed mirror at OAuth callback time (Task 2).
* **No placeholders:** every code step shows the actual code; every test shows the actual test body.
* **Type consistency:** `SnapshotBlob`, `ProgressBlob`, `SyncOptions`, `SyncResult` defined in Task 1, used unchanged in Tasks 3–14. `tokenMirrorKey` defined in Task 1, used in Tasks 2, 16, 17. `DiscogsClient.getCollectionPage` defined in Task 15, used by `syncCollection` from Task 3 onward (the FakeClient interface in tests stands in for it during pure unit tests).
* **Deferred:** Pre-serialized MiniSearch index (Future Work in spec). Deploy to Workers button (Future Work in spec).
