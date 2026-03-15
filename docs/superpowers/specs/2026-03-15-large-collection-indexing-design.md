# Large Collection Indexing Fix

**Date:** 2026-03-15
**Status:** Approved

## Problem

For users with large Discogs collections (4,000+ items), both `search_collection` and `get_collection_stats` return incomplete results. `get_collection_stats` reports 2,500 total releases when the actual collection has over 4,000 items. Searches miss known matches entirely.

Three bugs compound to cause this:

1. `getCompleteCollection` has `maxPages = 25`, capping indexing at 2,500 items (25 pages × 100 items/page).
2. The returned `pagination.items` is set to `allReleases.length` (the truncated count), not the real Discogs total — so tools report the wrong number.
3. The truncation detection logic is broken: `totalPages` has already been clamped to `Math.min(actualPages, maxPages)`, so `Math.ceil(allReleases.length / 100)` equals `totalPages`, making the condition always false. No warning is ever logged or shown.

## Scope

Support collections up to 5,000 items within existing Cloudflare Workers infrastructure (no new bindings, no Durable Objects). Collections larger than 5,000 items will still be truncated, but users will see an accurate count and a clear warning.

## Design

### Change 1 — `src/clients/cachedDiscogs.ts`: `getCompleteCollection`

- Change `maxPages` default from `25` to `50` (covers 5,000 items at 100/page).
- On the first page fetch, capture `actualTotalItems = pageResult.pagination.items` into a dedicated variable — Discogs always returns the real collection total in every page's pagination object. This variable must never be overwritten in subsequent iterations.
- Replace the broken truncation check with `actualTotalItems > allReleases.length`. `actualTotalItems` (from `pagination.items`) is the authoritative Discogs count; it is the only correct basis for this check.
- Change the returned `pagination.items` from `allReleases.length` to `actualTotalItems`, so callers always have access to the real Discogs total even when the indexed set is smaller. Note: the returned `pagination.pages` will remain the clamped value (e.g., 50) representing pages actually fetched — not the real Discogs page count. This is intentional: `pages` describes what was indexed; `items` describes the real collection. Tool-layer truncation checks must use `pagination.items`, not `pagination.pages`.
- Also fix the `collections` KV cache TTL: `SmartCache` currently writes `collections` entries with a 30-minute KV TTL (from `DEFAULT_CACHE_CONFIG`), but `getCompleteCollection` passes `maxAge: 45 * 60` expecting a 45-minute window. Because the KV entry expires before `maxAge` is ever checked, the effective cache window is 30 minutes, not 45. Extend `DEFAULT_CACHE_CONFIG.collections` TTL to 45 minutes (`45 * 60`) to align with the intended behaviour. Once this is done, the `{ maxAge: 45 * 60 }` override at the `getCompleteCollection` call site is redundant and should be removed.
- Update the cache key (naturally changes from `username:complete:25` to `username:complete:50`), bypassing any stale 25-page cached entries.
- Update comments to reflect the new limit.

**Performance note:** Cold-cache load for a 5,000-item collection makes 50 sequential API calls at ~1,100ms each ≈ 55 seconds of wall time. This is acceptable because the Cloudflare Workers 30s limit applies to CPU time, not wall-clock I/O wait; and this cost is paid once per 45-minute cache window.

Each inner `searchCollection` call has its own per-page cache entry (TTL: 20 minutes). Pages previously fetched (e.g., pages 1–25 from the old 25-page index) may be served from warm cache; pages beyond the old limit (26–50) will always hit the Discogs API on first access. In practice this means a user upgrading from the old limit may see a faster-than-worst-case cold load.

### Change 2 — `src/mcp/tools/authenticated.ts`: `get_collection_stats`

- Switch from `getCompleteCollectionReleases()` to `getCompleteCollection()` to get both the releases array and the real total count.
- When `pagination.items > releases.length`, change the "Total Releases" line to: `"X indexed of Y total"`.
- Append a footer note: `"⚠️ Only X of your Y releases have been indexed. Stats above reflect the indexed portion only."`

### Change 3 — `src/mcp/tools/authenticated.ts`: `search_collection`

- Switch from `getCompleteCollectionReleases()` to `getCompleteCollection()` for the same reason.
- When `pagination.items > releases.length`, append to the result: `"⚠️ Your collection has Y releases but only X were indexed. Some results may be missing."`

### No changes to

- `get_recommendations` — uses `getCompleteCollectionReleases()`, which wraps `getCompleteCollection()` and automatically benefits from the higher `maxPages` default without a call-site change.
- Resource files — same reasoning.
- The throttle mechanism or KV bindings.

## Success Criteria

- A user with 4,000 releases sees all 4,000 results from `search_collection` and correct stats from `get_collection_stats`.
- A user with 6,500 releases sees 5,000 indexed results with a clear warning that their collection is larger than what's indexed.
- No regressions for users with collections under 2,500 items.
