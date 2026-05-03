# Collection Sync Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Discogs collection fetch to a background hourly Workers cron that maintains a snapshot in KV, so `search_collection` reads from KV instead of paginating the live API on every cold start.

**Architecture:** New `src/sync/collectionSync.ts` exports a pure `syncCollection(client, kv, numericId, opts)` function. KV keys are scoped by `numericId` (the stable Discogs user identifier). The Discogs HTTP path needs the `username` instead, so the sync uses a `SyncClient` adapter — a small object that closes over `username + accessToken + accessTokenSecret + consumerKey + consumerSecret` and exposes one method, `fetchCollectionPage(opts)`. The adapter delegates to the existing `DiscogsClient.searchCollection(username, accessToken, accessTokenSecret, opts, consumerKey, consumerSecret)` method (`src/clients/discogs.ts:233`) — no new client method needed. The Worker's `scheduled()` handler iterates `ALLOWED_DISCOGS_USER_ID` (numeric IDs), loads each user's OAuth token + username from a new `discogs:token:{numericId}` KV mirror written by the existing OAuth callback, builds the adapter, and runs `syncCollection`. A new `refresh_collection` MCP tool registered via the existing `getSessionContext()` pattern calls the same function with `force: true`. `search_collection` reads from `collection:snapshot:{numericId}` when present, falling back to the existing live-pagination path during first-deploy bootstrap. Resumable via `collection:sync:progress:{numericId}` so partial failures self-heal within an hour.

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
  schemaVersion: 1
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
  fetchCollectionPage: (opts: { page: number; per_page: number; sort: string; sort_order: string }) => Promise<DiscogsCollectionResponse>
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
      async fetchCollectionPage(opts) {
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
  fetchCollectionPage(
    opts: { page: number; per_page: number; sort: string; sort_order: string },
  ): Promise<DiscogsCollectionResponse>
}

const PER_PAGE = 100

/**
 * Sync a single user's Discogs collection into KV.
 *
 * @param client  Adapter that closes over username + OAuth credentials.
 * @param kv      MCP_SESSIONS binding (or whatever namespace the keys helpers use).
 * @param numericId Stable Discogs user ID — used as the KV key suffix.
 * @param opts    Force flag, injected `now` for testability, injected `sleep` for retry tests.
 */
export async function syncCollection(
  client: SyncClient,
  kv: KVNamespace,
  numericId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const now = (opts.now ?? (() => new Date()))().toISOString()
  const allItems: DiscogsCollectionItem[] = []
  let totalPages = 1
  let totalCount = 0
  let topPageInstanceIds: number[] = []

  for (let page = 1; page <= totalPages; page++) {
    const res = await client.fetchCollectionPage({
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
  await kv.put(snapshotKey(numericId), JSON.stringify(snapshot))

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
    async fetchCollectionPage(opts) {
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
    async fetchCollectionPage(opts) {
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
  page: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<DiscogsCollectionResponse> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await client.fetchCollectionPage({ page, per_page: PER_PAGE, sort: 'added', sort_order: 'desc' })
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
const res = await client.fetchCollectionPage({ page, per_page: PER_PAGE, sort: 'added', sort_order: 'desc' })
```

to:

```ts
const res = await fetchPageWithRetry(client, page)
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
const res = await fetchPageWithRetry(client, page, sleep)
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
    async fetchCollectionPage(opts) {
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
      const res = await fetchPageWithRetry(client, page, sleep)
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
          schemaVersion: 1, startedAt: now, totalPages, totalCount, lastPageFetched, itemsSoFar,
        }
        await kv.put(progressKey(numericId), JSON.stringify(progress), {
          // 7-day TTL so abandoned syncs auto-cleanup. Spec §KV Schema.
          expirationTtl: 7 * 24 * 60 * 60,
        })
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
  const snapshotJson = JSON.stringify(snapshot)
  // KV value limit is 25MB. ~600B/item × 1,500 items ≈ 900KB is comfortable;
  // a self-hoster with 5,000+ items will start pushing 3MB. Log the size so
  // we can spot the problem before it hits the limit.
  console.log(`sync ${numericId}: snapshot size ${snapshotJson.length} bytes, ${totalCount} items`)
  await kv.put(snapshotKey(numericId), snapshotJson)
  await kv.delete(progressKey(numericId))

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
    async fetchCollectionPage(opts) {
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
const existingProgressRaw = await kv.get(progressKey(numericId), 'json') as ProgressBlob | null
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
    const res = await fetchPageWithRetry(client, page, sleep)
    if (page === 1) {
      totalPages = res.pagination.pages
      totalCount = res.pagination.items
      topPageInstanceIds = res.releases.map((r) => r.instance_id)
    }
    itemsSoFar.push(...res.releases)
    lastPageFetched = page
    if (page < totalPages) {
      const progress: ProgressBlob = { schemaVersion: 1, startedAt: now, totalPages, totalCount, lastPageFetched, itemsSoFar }
      await kv.put(progressKey(numericId), JSON.stringify(progress), { expirationTtl: 7 * 24 * 60 * 60 })
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
    async fetchCollectionPage(opts) {
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

- [ ] **Step 3: Add drift detection on every page (not just on resume)**

Inside the page loop, after the page fetch, before appending items. Spec §Sync Flow step 4 calls for this on every page — a fresh full sync that grows from 1,500→1,600 mid-pagination should restart, same as a resumed one.

```ts
// Drift check: every page's pagination.items must match the totalCount
// recorded on page 1 (or carried forward from progress on resume). Discogs
// returns the live count in every page response, so any disagreement means
// the collection changed mid-sync. Skip the check on page 1 itself — that's
// the page that defines totalCount.
if (page > 1 && res.pagination.items !== totalCount) {
  await kv.delete(progressKey(numericId))
  return syncCollection(client, kv, numericId, { ...opts, force: true })
}
```

The recursive call passes the same opts. The fresh entry won't see a progress key (we just deleted it), so it starts from page 1.

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
    async fetchCollectionPage(opts) {
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
    async fetchCollectionPage(opts) {
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
  // Probe gate: only runs when both a snapshot exists AND a recent
  // lastForcedFullSync is on file. On a fresh deploy neither key exists,
  // so this block is skipped and we fall through to a full pagination
  // (the bootstrap path). Don't "fix" the gate to run probe whenever a
  // snapshot exists — that would skip the weekly forced full sweep.
  const existingSnapshot = await kv.get<SnapshotBlob>(snapshotKey(numericId), 'json')
  const lastForced = await kv.get(lastForcedFullSyncKey(numericId))
  const lastForcedFresh = lastForced && Date.now() - new Date(lastForced).getTime() < SEVEN_DAYS_MS

  if (existingSnapshot && lastForcedFresh) {
    // Run probe: fetch page 1, compare count + top instance_ids
    const probe = await fetchPageWithRetry(client, 1, sleep)
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
await kv.put(lastForcedFullSyncKey(numericId), now)
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
    async fetchCollectionPage(opts) {
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
    async fetchCollectionPage(opts) {
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
    async fetchCollectionPage(opts) {
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
    async fetchCollectionPage(opts) {
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

## Task 15: Confirm `SyncClient` is exported (no new client code needed)

No new method on `DiscogsClient` is needed. The existing `DiscogsClient.searchCollection(username, accessToken, accessTokenSecret, options, consumerKey, consumerSecret)` at `src/clients/discogs.ts:233` already paginates `/users/{username}/collection/folders/0/releases` exactly the way `syncCollection` needs (when `options.query` is omitted, it does plain pagination). The `scheduled()` handler and `refresh_collection` tool will each build a small inline `SyncClient` object that calls it — no factory module needed.

- [ ] **Step 1: Confirm `SyncClient` is exported from `src/sync/collectionSync.ts`**

The `SyncClient` interface defined in Task 3 needs to be exported (used by the scheduled handler and the tool in Tasks 16 and 18). If you wrote it as a non-exported interface, change to `export interface SyncClient`.

- [ ] **Step 2: Re-run sync tests**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/collectionSync.spec.ts`
Expected: all sync tests still PASS. No code change here, just an export visibility check.

- [ ] **Step 3: Commit (only if export was missing)**

```bash
cd ~/git/discogs-mcp
git add src/sync/collectionSync.ts
git commit -m "Export SyncClient interface for use by scheduled handler and tool"
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
import { env, createScheduledController, createExecutionContext } from 'cloudflare:test'
import worker from '../../src/index-oauth'
import { snapshotKey, tokenMirrorKey } from '../../src/sync/keys'

// The scheduled handler ultimately calls DiscogsClient.searchCollection, which
// routes through the rate-limiter Durable Object — its fetch runs in a separate
// isolate where globalThis.fetch stubbing has no effect. To keep the test
// hermetic, vi.mock DiscogsClient itself so the handler's `new DiscogsClient(...)`
// returns a fake whose searchCollection resolves with a canned page.
vi.mock('../../src/clients/discogs', async (orig) => {
  const actual = (await orig()) as object
  return {
    ...actual,
    DiscogsClient: vi.fn().mockImplementation(() => ({
      searchCollection: vi.fn().mockResolvedValue({
        pagination: { pages: 1, page: 1, per_page: 100, items: 1, urls: {} },
        releases: [{
          id: 1, instance_id: 101, folder_id: 0, date_added: '2026-01-01T00:00:00Z', rating: 0,
          basic_information: {
            id: 1, title: 't', year: 2020,
            resource_url: '', thumb: '', cover_image: '',
            formats: [], labels: [], artists: [], genres: [], styles: [],
          },
        }],
      }),
      setRateLimiter: vi.fn(),
    })),
  }
})

describe('scheduled() handler', () => {
  beforeEach(async () => {
    const list = await env.MCP_SESSIONS.list()
    for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
  })

  it('syncs every user in ALLOWED_DISCOGS_USER_ID who has a token mirror', async () => {
    for (const id of ['12345', '67890']) {
      await env.MCP_SESSIONS.put(tokenMirrorKey(id), JSON.stringify({
        numericId: id, username: `user${id}`,
        accessToken: 'tok', accessTokenSecret: 'sec',
      }))
    }

    const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '0 * * * *' })
    const ctx = createExecutionContext()
    await worker.scheduled!(
      ctrl,
      { ...env, ALLOWED_DISCOGS_USER_ID: '12345,67890' } as any,
      ctx,
    )

    expect(await env.MCP_SESSIONS.get(snapshotKey('12345'))).toBeTruthy()
    expect(await env.MCP_SESSIONS.get(snapshotKey('67890'))).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/scheduled.spec.ts`
Expected: FAIL — `worker.scheduled` undefined.

- [ ] **Step 3: Add static imports to the top of `src/index-oauth.ts`**

```ts
import { syncCollection, type SyncClient } from './sync/collectionSync'
import { tokenMirrorKey } from './sync/keys'
import type { TokenMirror, SyncResult } from './sync/types'
import { DiscogsClient } from './clients/discogs'
```

- [ ] **Step 4: Add `scheduled()` to `src/index-oauth.ts`**

Inside the existing `export default { ... }` object (around line 177), add alongside `fetch`:

```ts
async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
  const allowed = (env.ALLOWED_DISCOGS_USER_ID || '').split(',').map((s) => s.trim()).filter(Boolean)

  for (const numericId of allowed) {
    try {
      const tokenStr = await env.MCP_SESSIONS.get(tokenMirrorKey(numericId))
      if (!tokenStr) {
        await logSyncOutcome(env, numericId, { outcome: 'no_token', pagesFetched: 0 })
        continue
      }
      const token = JSON.parse(tokenStr) as TokenMirror

      // Build the Discogs client the same way every other call site does
      // (see src/mcp/tools/authenticated.ts — credentials are passed per call,
      // not via constructor).
      const discogsClient = new DiscogsClient()
      discogsClient.setRateLimiter(env.RATE_LIMITER)

      // Inline SyncClient: closes over username + creds, calls the existing
      // searchCollection method which already paginates the right endpoint.
      const syncClient: SyncClient = {
        fetchCollectionPage: (opts) =>
          discogsClient.searchCollection(
            token.username,
            token.accessToken,
            token.accessTokenSecret,
            { page: opts.page, per_page: opts.per_page, sort: 'added', sort_order: 'desc' },
            env.DISCOGS_CONSUMER_KEY,
            env.DISCOGS_CONSUMER_SECRET,
          ),
      }

      const result = await syncCollection(syncClient, env.MCP_SESSIONS, numericId, {})
      await logSyncOutcome(env, numericId, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 401 → token revoked. Delete the mirror so the cron stops crashing
      // on this user every hour until they re-authenticate via the MCP flow.
      // Spec §Error Handling: log token_invalid, skip.
      if (/\b401\b|Unauthorized/i.test(msg)) {
        await env.MCP_SESSIONS.delete(tokenMirrorKey(numericId))
        await logSyncOutcome(env, numericId, { outcome: 'token_invalid', pagesFetched: 0, error: msg })
      } else {
        await logSyncOutcome(env, numericId, { outcome: 'crashed', pagesFetched: 0, error: msg })
      }
    }
  }
}
```

Add a tiny helper at module scope (above the `export default`):

```ts
async function logSyncOutcome(env: Env, numericId: string, result: SyncResult) {
  const entry = { timestamp: new Date().toISOString(), numericId, ...result }
  await env.MCP_LOGS.put(`sync:${entry.timestamp}:${numericId}`, JSON.stringify(entry), {
    expirationTtl: 30 * 24 * 60 * 60,
  })
}

// Note on concurrency: users in ALLOWED_DISCOGS_USER_ID are processed
// sequentially. With an allowlist of 1-2 users (the maintainer + occasional
// shared account), sequential is well within Workers' wall-time budget for
// scheduled handlers and keeps the rate-limiter DO simple. If the allowlist
// ever grows past ~5 users with large collections, switch to Promise.all
// over the user loop. Don't reach for ctx.waitUntil here — that's a fetch-
// handler pattern; scheduled handlers should await everything they care about.
```

Inspect `src/clients/discogs.ts` first to confirm the `new DiscogsClient()` no-arg constructor is correct (line ~152). If it requires args, conform.

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
  // Override the top-level vi.mock for this one test to make alpha throw.
  const { DiscogsClient } = await import('../../src/clients/discogs')
  ;(DiscogsClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
    searchCollection: vi.fn().mockRejectedValue(new Error('alpha boom')),
    setRateLimiter: vi.fn(),
  }))

  await env.MCP_SESSIONS.put(tokenMirrorKey('alpha'), JSON.stringify({
    numericId: 'alpha', username: 'a', accessToken: 'tok', accessTokenSecret: 'sec',
  }))
  // 'beta' has no token mirror

  const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '0 * * * *' })
  const ctx = createExecutionContext()
  await worker.scheduled!(
    ctrl,
    { ...env, ALLOWED_DISCOGS_USER_ID: 'alpha,beta' } as any,
    ctx,
  )

  // alpha crashed, beta got no_token — both logged, neither blocked the other
  const logs = await env.MCP_LOGS.list({ prefix: 'sync:' })
  const ids = await Promise.all(logs.keys.map(async (k) => {
    const v = await env.MCP_LOGS.get(k.name, 'json') as { numericId: string; outcome: string }
    return `${v.numericId}:${v.outcome}`
  }))
  expect(ids.sort()).toEqual(['alpha:crashed', 'beta:no_token'])
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

The actual tool-registration pattern in `src/mcp/tools/authenticated.ts:511` is:

```ts
server.tool(
  'tool_name',
  'description',
  { /* zod schema */ },
  async ({ args }) => {
    const { session, connectionId } = await getSessionContext()
    if (!session) return { content: [{ type: 'text', text: generateAuthInstructions(connectionId) }] }
    // session.username, session.numericId, session.accessToken, session.accessTokenSecret available
    // env, getSessionContext are closure variables from registerAuthenticatedTools(server, env, getSessionContext)
  }
)
```

The handler does NOT receive a `ctx` arg — it closes over `env` and `getSessionContext`. There is no `ctx.discogsClient` to pass in; the handler builds the client itself, same as every other tool in the file (see lines 593-595, 743-745).

**Files:**
- Modify: `src/mcp/tools/authenticated.ts` — register the tool inside `registerAuthenticatedTools`.
- Test: `test/sync/refresh-collection-tool.spec.ts`.

- [ ] **Step 1: Find an existing authenticated-tool test to mirror**

Run: `cd ~/git/discogs-mcp && rg -l "registerAuthenticatedTools|getSessionContext" test/`
Read the closest match. The test harness will set up an `McpServer`, call `registerAuthenticatedTools(server, env, fakeGetSessionContext)`, then invoke the tool. Mirror that shape.

- [ ] **Step 2: Write the failing test**

```ts
// test/sync/refresh-collection-tool.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAuthenticatedTools } from '../../src/mcp/tools/authenticated'
import { progressKey, snapshotKey } from '../../src/sync/keys'

// Mock DiscogsClient so the tool's call doesn't go through the rate limiter DO.
vi.mock('../../src/clients/discogs', async (orig) => {
  const actual = (await orig()) as object
  return {
    ...actual,
    DiscogsClient: vi.fn().mockImplementation(() => ({
      searchCollection: vi.fn().mockResolvedValue({
        pagination: { pages: 1, page: 1, per_page: 100, items: 1, urls: {} },
        releases: [{ id: 1, instance_id: 101, folder_id: 0, date_added: '2026-01-01T00:00:00Z', rating: 0, basic_information: { id: 1, title: 't', year: 2020, resource_url: '', thumb: '', cover_image: '', formats: [], labels: [], artists: [], genres: [], styles: [] } }],
      }),
      setRateLimiter: vi.fn(),
    })),
  }
})

const fakeSession = () => ({
  session: {
    username: 'u', numericId: '12345',
    accessToken: 'tok', accessTokenSecret: 'sec',
  },
  connectionId: 'conn-1',
})

async function callRefresh(server: McpServer): Promise<any> {
  // The MCP SDK's preferred test path is server.callTool — confirm by reading the
  // existing test harness; if it uses a different invocation, mirror that.
  const result = await server.request({
    method: 'tools/call',
    params: { name: 'refresh_collection', arguments: {} },
  } as any, undefined as any)
  return JSON.parse(result.content[0].text)
}

describe('refresh_collection tool', () => {
  beforeEach(async () => {
    const list = await env.MCP_SESSIONS.list()
    for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
  })

  it('forces a full sync and returns status: completed with count + fetchedAt', async () => {
    const server = new McpServer({ name: 't', version: '0' })
    registerAuthenticatedTools(server, env as any, async () => fakeSession())
    const result = await callRefresh(server)
    expect(result.status).toBe('completed')
    expect(result.count).toBe(1)
    expect(result.fetchedAt).toBeTruthy()
    expect(await env.MCP_SESSIONS.get(snapshotKey('12345'))).toBeTruthy()
  })

  it('returns status: resumed when a fresh progress key exists', async () => {
    // Pre-populate progress that says "we've fetched page 1 of 1, totalCount 1"
    await env.MCP_SESSIONS.put(progressKey('12345'), JSON.stringify({
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      totalPages: 1, totalCount: 1, lastPageFetched: 1,
      itemsSoFar: [{
        id: 1, instance_id: 101, folder_id: 0, date_added: '2026-01-01T00:00:00Z', rating: 0,
        basic_information: { id: 1, title: 't', year: 2020, resource_url: '', thumb: '', cover_image: '', formats: [], labels: [], artists: [], genres: [], styles: [] },
      }],
    }))
    const server = new McpServer({ name: 't', version: '0' })
    registerAuthenticatedTools(server, env as any, async () => fakeSession())
    const result = await callRefresh(server)
    // syncCollection sees a fresh progress key with lastPageFetched === totalPages,
    // so the loop runs zero iterations and goes straight to atomic swap.
    expect(result.status).toBe('resumed')
  })
})
```

If the existing test harness invokes tools differently (likely — read it first), replace `callRefresh` to match.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/refresh-collection-tool.spec.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 4: Register the tool in `src/mcp/tools/authenticated.ts`**

Add inside `registerAuthenticatedTools` (alongside `search_collection`, around line 511):

```ts
server.tool(
  'refresh_collection',
  'Force an immediate full refresh of the cached collection snapshot. Use after adding or removing items in Discogs if you need them visible to search before the next hourly sync.',
  {}, // no args
  async () => {
    const { session, connectionId } = await getSessionContext()
    if (!session) {
      return { content: [{ type: 'text', text: generateAuthInstructions(connectionId) }] }
    }

    const discogsClient = new DiscogsClient()
    discogsClient.setRateLimiter(env.RATE_LIMITER)

    const syncClient: SyncClient = {
      fetchCollectionPage: (opts) =>
        discogsClient.searchCollection(
          session.username, session.accessToken, session.accessTokenSecret,
          { page: opts.page, per_page: opts.per_page, sort: 'added', sort_order: 'desc' },
          env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET,
        ),
    }

    // Force a full sync. If a stalled progress key exists, syncCollection
    // resumes it and returns outcome: 'resumed' — the tool surfaces that
    // verbatim so the user knows partial work was salvaged. Concurrent calls
    // race harmlessly: each one drives the same sync forward; the second
    // arrival just sees a more advanced progress key.
    const result = await syncCollection(syncClient, env.MCP_SESSIONS, session.numericId, { force: true })
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: result.outcome,
          count: result.count,
          fetchedAt: result.fetchedAt,
          pagesFetched: result.pagesFetched,
        }),
      }],
    }
  },
)
```

Add the static import at the top of `src/mcp/tools/authenticated.ts` if not already present:

```ts
import { syncCollection, type SyncClient } from '../../sync/collectionSync'
```

(`DiscogsClient` is already imported in this file.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/refresh-collection-tool.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/authenticated.ts test/sync/refresh-collection-tool.spec.ts
git commit -m "Add refresh_collection MCP tool with concurrent-call guard"
```

---

## Task 19: `search_collection` Reads from Snapshot When Present

The actual method `search_collection` calls is `cachedClient.getCompleteCollection(username, accessToken, accessTokenSecret, consumerKey, consumerSecret, perPage, budgetMs)` (see `src/mcp/tools/authenticated.ts:591` and `src/clients/cachedDiscogs.ts`). It returns `{ releases: DiscogsCollectionItem[], pagination: ..., partial: boolean }`. The fix: short-circuit it to read from `collection:snapshot:{numericId}` when present. The numericId isn't a parameter today, so we add it.

**Files:**
- Modify: `src/clients/cachedDiscogs.ts` — add a `numericId` parameter to `getCompleteCollection`, check the snapshot first.
- Modify: `src/mcp/tools/authenticated.ts` — pass `session.numericId` at every `getCompleteCollection` call site.
- Test: `test/sync/search-collection-snapshot.spec.ts`

- [ ] **Step 1: Locate the call sites**

Run: `cd ~/git/discogs-mcp && rg -n "getCompleteCollection\(" src/`
Expected: one or more callers (`search_collection`, possibly recommendations or stats tools). Note the line numbers — every one needs the new `numericId` arg.

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
    // Mock DiscogsClient.searchCollection — this is what cachedDiscogs would
    // call on a cache miss. If it gets called, the snapshot read path is broken.
    const searchSpy = vi.fn()
    vi.mock('../../src/clients/discogs', async (orig) => {
      const actual = (await orig()) as object
      return {
        ...actual,
        DiscogsClient: vi.fn().mockImplementation(() => ({
          searchCollection: searchSpy,
          setRateLimiter: vi.fn(),
        })),
      }
    })

    // Build the same harness used in Task 18 (registerAuthenticatedTools + fakeSession),
    // call search_collection. Confirm Snapshot Album is returned and searchSpy was never called.
    // (Pseudocode — adapt to whatever invocation pattern the existing test harness uses.)
    const result = await callSearchCollection({ query: 'snapshot' }, { username: 'someuser', numericId: 'u' })
    expect(result.results.some((r: any) => r.title === 'Snapshot Album')).toBe(true)
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it('falls back to live pagination when no snapshot exists', async () => {
    const searchSpy = vi.fn().mockResolvedValue({
      pagination: { pages: 1, page: 1, per_page: 100, items: 1, urls: {} },
      releases: [], // shape doesn't matter here; we only assert it was called
    })
    vi.mock('../../src/clients/discogs', async (orig) => {
      const actual = (await orig()) as object
      return {
        ...actual,
        DiscogsClient: vi.fn().mockImplementation(() => ({
          searchCollection: searchSpy,
          setRateLimiter: vi.fn(),
        })),
      }
    })

    await callSearchCollection({ query: 'live' }, { username: 'someuser', numericId: 'u' })
    expect(searchSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/git/discogs-mcp && npx vitest run test/sync/search-collection-snapshot.spec.ts`
Expected: FAIL — snapshot path not wired.

- [ ] **Step 4: Wire the snapshot read into `getCompleteCollection`**

Add `numericId` as the first parameter (or after `username` — pick whichever fits the existing signature naturally). At the top of the method, check the snapshot:

```ts
import { snapshotKey } from '../sync/keys'
import type { SnapshotBlob } from '../sync/types'

async getCompleteCollection(
  numericId: string,
  username: string,
  accessToken: string,
  accessTokenSecret: string,
  consumerKey: string,
  consumerSecret: string,
  perPage: number,
  budgetMs: number,
): Promise<{ releases: DiscogsCollectionItem[]; pagination: any; partial: boolean }> {
  // Snapshot fast path — the cron has been pre-fetching this user's collection.
  const snapshot = await this.kv.get<SnapshotBlob>(snapshotKey(numericId), 'json')
  if (snapshot && Array.isArray(snapshot.items)) {
    return {
      releases: snapshot.items,
      pagination: { page: 1, pages: 1, per_page: snapshot.items.length, items: snapshot.count, urls: {} },
      partial: false,
    }
  }
  // Existing live pagination path — unchanged
  return this.fetchCompleteCollectionLive(username, accessToken, accessTokenSecret, consumerKey, consumerSecret, perPage, budgetMs)
}
```

Rename the existing body into `private fetchCompleteCollectionLive(...)`. Keep its existing per-method KV cache layer untouched.

Update every call site to pass `numericId` as the new first argument. Confirmed call sites:

* `src/mcp/tools/authenticated.ts:592, 603, 957, 968` — pass `session.numericId`.
* `src/mcp/resources/discogs.ts:60, 71` — pass the numeric ID from the resource's session context (read the file to confirm the variable name).
* `src/clients/cachedDiscogs.ts:403` — self-call inside another method on the same class; pass through whatever `numericId` that method receives. This means the *caller* method also needs `numericId` added to its signature; trace the chain with `rg -n "getCompleteCollection\(" src/`.

Run `npx tsc --noEmit` after the changes to confirm every caller compiles. Missing one will surface here.

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
