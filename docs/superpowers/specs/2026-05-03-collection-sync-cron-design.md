# Collection Sync Cron — Design

**Date:** 2026-05-03
**Status:** Draft
**Author:** Rian van der Merwe

## Problem

`search_collection` is slow on first call because it has to paginate the entire Discogs collection (~1,500 items, ~15 API calls) before MiniSearch can index anything. Subsequent calls hit `cachedDiscogs.ts`'s long-TTL KV caches and are fast, but cold cache and post-cache-eviction calls hit the same wall. Issue [#18](https://github.com/rianvdm/discogs-mcp/issues/18) tracks the cold-cache fetch budget timing out at ~1000/1512 items.

Since `discogs-mcp` is now a self-hosted MCP server (see `wrangler.toml`: `ALLOWED_DISCOGS_USER_ID` locks production to the maintainer's account; everyone else self-hosts), the multi-user fan-out concern that ruled out aggressive pre-fetching is gone. We can move the collection fetch to a background cron and serve `search_collection` from a pre-built snapshot in KV.

## Goals

* Eliminate cold-start latency for `search_collection` after the first sync completes.
* Sync incrementally — never re-fetch unchanged data daily.
* Self-heal partial failures within ~1 hour, not 24 hours.
* Never serve a partial / corrupt snapshot to readers.

## Non-Goals

* Per-release detail caching (`get_release` etc.) — handled by existing `cachedDiscogs.ts` per-method TTLs, untouched.
* Webhook-driven freshness — Discogs has no collection-change webhooks.
* Pre-serializing the MiniSearch index into KV — possible follow-up if rebuild latency becomes an issue.

## Architecture

Three new pieces in the existing Worker:

1. **`src/sync/collectionSync.ts`** — pure logic. Exports `syncCollection(client, kv, userId, opts)`. Takes injected dependencies so it's testable without Workers runtime.
2. **`scheduled()` handler in `src/index-oauth.ts`** — iterates `ALLOWED_DISCOGS_USER_ID`, loads each user's stored Discogs OAuth token from KV, builds a `DiscogsClient` per user, calls `syncCollection`. Logs each user's outcome to `MCP_LOGS`.
3. **`refresh_collection` MCP tool** — authenticated tool in `src/mcp/tools/authenticated.ts` that calls `syncCollection` with `force: true`.

`search_collection` is modified to read from `collection:snapshot:{userId}` when present, falling back to the existing `cachedDiscogs.getCollectionItems` path on cache miss. The legacy path stays as the first-deploy bootstrap fallback so users aren't blocked while the cron seeds KV.

`cachedDiscogs.ts` per-method caches stay untouched. The snapshot is purely the search-corpus optimization.

## KV Schema

### `collection:snapshot:{userId}` (new — main blob)

```ts
{
  schemaVersion: 1,
  fetchedAt: "2026-05-03T18:30:00Z",
  count: 1512,
  topPageInstanceIds: number[],   // page-1-by-added-desc instance_ids, for the next probe
  items: DiscogsCollectionItem[]  // verbatim Discogs response shape, no transformation
}
```

`DiscogsCollectionItem` is the existing type from `src/clients/discogs.ts:48` — full `basic_information` block (artists, title, year, formats, labels, genres, styles, master_id, thumb, cover_image), plus `instance_id`, `folder_id`, `date_added`, `rating`. Storing the verbatim shape means the snapshot is a drop-in replacement for `cachedDiscogs.getCollectionItems` — no shim layer needed in `searchRanking.ts`.

Size estimate: ~1,500 items × ~600 B ≈ 900 KB. KV value limit is 25 MB. Comfortable.

### `collection:sync:progress:{userId}` (new — in-flight checkpoint)

```ts
// TTL: 7 days (auto-cleanup if abandoned)
{
  startedAt: "2026-05-03T18:30:00Z",
  totalPages: 16,
  totalCount: 1512,
  lastPageFetched: 7,
  itemsSoFar: DiscogsCollectionItem[]
}
```

### `collection:sync:lastForcedFullSync:{userId}` (new — weekly-sweep timestamp)

ISO timestamp string. Used by the weekly forced full-sync belt-and-braces.

### `discogs:token:{userId}` (new — token mirror, only added if needed)

Per-user mirror of the Discogs OAuth access token, written at the end of the OAuth callback. Necessary because the cron has no request context and can't read tokens from the JWT-bearing Authorization header. If the existing OAuth code already stores tokens user-keyed in KV, this mirror is unnecessary; confirmed during implementation.

## Sync Flow

On every entry (cron tick, `refresh_collection`, or any explicit invocation):

1. Look for `collection:sync:progress:{userId}`. If present and `startedAt` < 7 days, **resume from `lastPageFetched + 1`**. Otherwise start fresh from page 1.
2. **Probe (only when starting fresh, not on resume, and not when `force: true`):** fetch `/users/{u}/collection/folders/0?per_page=100&page=1&sort=added&sort_order=desc`. Compare:
   * `pagination.items` vs. snapshot's `count`
   * top-100 `instance_id` set vs. snapshot's `topPageInstanceIds`
   * If both match AND `lastForcedFullSync` < 7 days ago → exit with `outcome: "skipped"`.
   * Otherwise proceed with full pagination. The page-1 response we just fetched is reused as page 1 of the sync — no duplicate call.
3. **Per-page fetch with retry.** Each page wrapped in 3 attempts with exponential backoff (1s, 2s, 4s). Honor `Retry-After` on 429.
4. **Drift check on every page.** If any page's `pagination.items` disagrees with the page-1 `totalCount` recorded in progress, the collection changed mid-sync — discard progress, restart from page 1.
5. **Persist progress** after each successful page write: append items, increment `lastPageFetched`, write the progress key.
6. **Atomic swap** on completion: write `collection:snapshot:{userId}` (the new authoritative blob) → write `collection:sync:lastForcedFullSync:{userId}` if this was a full sync → delete progress key. Readers never see a partial snapshot.
7. On unrecoverable error, leave progress in place and log to `MCP_LOGS`. The next cron tick or `refresh_collection` resumes.

## Cron Cadence

Hourly (`0 * * * *`). Decouples cron frequency from refresh cadence — partial failures recover within an hour, not a day.

Three-branch tick logic:

| Condition | Action |
|---|---|
| Progress key present | Resume immediately, no probe |
| Last successful sync < 23h ago | Exit, no API call |
| Otherwise | Run probe; full sync if probe trips |

Steady state: 24 ticks/day × 1 KV read each = trivial. Discogs API only touched ~1×/day (probe + maybe sync) plus during in-flight resumes.

## `scheduled()` Handler

```ts
export default {
  async scheduled(event, env, ctx) {
    const allowedIds = (env.ALLOWED_DISCOGS_USER_ID || '').split(',').filter(Boolean)
    for (const userId of allowedIds) {
      try {
        const token = await env.MCP_SESSIONS.get(`discogs:token:${userId}`, 'json')
        if (!token) {
          await logOutcome(env, userId, { outcome: 'no_token' })
          continue
        }
        const client = new DiscogsClient({ token, rateLimiter: env.RATE_LIMITER })
        const result = await syncCollection(client, env.MCP_SESSIONS, userId, {})
        await logOutcome(env, userId, result)
      } catch (err) {
        await logOutcome(env, userId, { outcome: 'crashed', error: String(err) })
      }
    }
  }
}
```

Per-user try/catch ensures one user's failure (relevant when allowlist has 2 users on the maintainer instance) doesn't block others.

## `refresh_collection` Tool

```ts
{
  name: 'refresh_collection',
  description:
    'Force an immediate full refresh of the cached collection snapshot. Use after adding or removing items in Discogs if you need them visible to search before the next hourly sync.',
  inputSchema: { type: 'object', properties: {}, required: [] }
}
```

Behavior:

1. Calls `syncCollection(client, kv, userId, { force: true })`.
2. Returns `{ status: 'completed' | 'resumed' | 'in_progress', count, fetchedAt, pagesFetched }`.
   * `'in_progress'` returned without starting a second sync if a parallel cron tick is already mid-run (cheap KV check on progress key prevents double-runs).
   * `'resumed'` returned when the call picked up a stalled progress key.
3. Synchronous from the user's perspective. Typical duration ~15s for a 1,500-item collection. For self-hosters with much larger collections this could exceed the MCP request timeout; `ctx.waitUntil` finishes the sync in the background even if the response times out client-side. The next call sees the snapshot.

## Error Handling

| Scenario | Behavior |
|---|---|
| Discogs returns 500 (transient) | Per-page retry, 3 attempts |
| Discogs returns 429 | Honor `Retry-After`, retry up to 3 attempts |
| Per-page retries exhausted | Persist progress, log `outcome: "failed"`, exit. Next tick resumes. |
| Drift mid-sync (count changes between pages) | Discard progress, restart from page 1 |
| OAuth token missing in KV | Log `outcome: "no_token"`, skip user. Not an error. |
| OAuth token returns 401 | Delete token mirror, log `outcome: "token_invalid"`, skip. User re-auths via normal MCP flow. |
| One user's sync crashes | Per-user try/catch, other users still sync |
| Progress key >7 days old | Ignored on next entry, sync restarts from page 1 |

All outcomes logged to `MCP_LOGS` as `{ userId, outcome, pagesFetched, durationMs, error? }`.

## search_collection Read Path

```ts
async function loadCollection(kv, userId) {
  const snapshot = await kv.get(`collection:snapshot:${userId}`, 'json')
  if (snapshot) return { source: 'snapshot', items: snapshot.items, fetchedAt: snapshot.fetchedAt }
  // Bootstrap fallback while cron seeds KV for the first time
  const items = await cachedDiscogs.getCollectionItems(userId)
  return { source: 'legacy', items, fetchedAt: null }
}
```

Tool response includes `fetchedAt` so the caller can see how stale the data is. After any `refresh_collection` call, `fetchedAt` reflects the moment the sync completed.

## Testing

Test-driven, red-green-refactor. Each test below corresponds to one TDD slice — write the failing test, write the smallest code to make it pass, refactor, commit. Sequenced so earlier tests define interfaces later tests depend on.

### Unit tests (`test/sync/collectionSync.test.ts`)

1. **First-run bootstrap.** No snapshot in KV → repaginates, writes snapshot.
2. **Atomic swap.** Reading `collection:snapshot:{userId}` between page fetches returns previous good snapshot, never partial.
3. **Per-page retry.** Discogs returns 500-500-200 on page 5 → sync completes, 3 fetch attempts logged.
4. **Retry exhausted → progress persisted.** All 3 attempts fail on page 5 → `outcome: "failed"`, progress key has `lastPageFetched: 4`, snapshot key untouched.
5. **Resume.** Progress key with `lastPageFetched: 7` → sync starts at page 8, items from progress preserved in final snapshot.
6. **Drift-mid-resume.** Page 8 returns `pagination.items: 1600` but progress recorded `totalCount: 1512` → progress discarded, sync restarts from page 1.
7. **Stale progress.** Progress with `startedAt` >7 days → ignored, sync starts from page 1.
8. **Probe — no-op.** Same `count` and same page-1 `instance_id` set → `outcome: "skipped"`, no full pagination.
9. **Probe — count mismatch.** Different `count` → triggers full repaginate.
10. **Probe — swap detection.** Same `count`, different page-1 instance_id set → triggers full repaginate.
11. **Forced full sync.** `{ force: true }` skips probe.
12. **Weekly forced sweep.** `lastForcedFullSync` >7 days ago → repaginates even when probe says skip.

### Integration tests (`test/index-oauth.scheduled.test.ts`)

13. **Scheduled handler iterates allowlist.** Two users, both with valid tokens → both synced. One missing token → logged as `no_token`, other proceeds.
14. **Per-user crash isolation.** First user's Discogs call throws → caught and logged, second user still syncs cleanly.
15. **`refresh_collection` tool — force=true.** Sync runs, response includes `count` + `fetchedAt`.
16. **`refresh_collection` tool — concurrent.** Second call returns `in_progress` without starting a duplicate sync.
17. **`search_collection` reads from snapshot when present.** Pre-populated snapshot → tool hits new path, doesn't call legacy `cachedDiscogs.getCollectionItems`.
18. **`search_collection` falls back when snapshot absent.** No snapshot → legacy path used.

### Mocking

Discogs HTTP responses mocked at the `fetch` boundary using `vi.fn()`. `MCP_LOGS` writes asserted to verify structured-log shape. No real network calls.

### Excluded

* End-to-end test of cron firing on schedule. vitest can invoke `scheduled()` directly with a fake `ScheduledEvent`; we don't need to validate Cloudflare's cron infrastructure.

## Configuration Changes

`wrangler.toml`:

```toml
[triggers]
crons = ["0 * * * *"]
```

Same triggers block under `[env.production]`.

## Rollout

1. Ship the cron, sync logic, and `refresh_collection` tool. `search_collection` falls back to the legacy path because no snapshot exists yet.
2. First cron tick (within an hour of deploy) starts the initial sync. May complete in one tick or take several ticks if pagination is interrupted.
3. After the snapshot lands, `search_collection` automatically uses the fast path. No flag, no migration, no user action needed.
4. Self-hosters with large collections can call `refresh_collection` immediately after auth to skip the wait.

## Open Questions

* **OAuth token storage shape.** Confirm during implementation whether the existing OAuth code already writes a per-user Discogs access token in KV. If yes, no mirror key needed; if no, add one in the OAuth callback handler. Implementation discovery, not a design decision.
* **KV binding choice.** Spec uses `MCP_SESSIONS` for snapshot + progress + lastForcedFullSync keys. Reasonable default given the existing namespaces, but a dedicated `COLLECTION_KV` namespace would be cleaner if we expect snapshot growth or want separate eviction policies. Decide during implementation; either path is reversible with a one-line wrangler change + key migration.

## References

* Issue [#18](https://github.com/rianvdm/discogs-mcp/issues/18) — cold-cache fetch budget timeouts.
* `src/clients/discogs.ts:48` — `DiscogsCollectionItem` shape.
* `src/clients/cachedDiscogs.ts` — existing per-method KV cache layer (untouched by this design).
* `src/utils/searchRanking.ts` — consumes `DiscogsCollectionItem[]` directly, no transformation needed.
