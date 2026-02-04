# Rate Limit Optimization Plan

> **Status:** In Progress
> **Created:** 2026-01-31
> **Problem:** Single MCP tool invocations exhaust Discogs API rate limits (60 req/min) due to full-collection pagination fan-out, especially with mood-expanded searches on large collections (1000+ items).

## Problem Analysis

### Discogs API Constraints

- **60 authenticated requests per minute** (1 per second)
- No server-side search within user collections — all filtering must be client-side
- Collection data returned in pages of max 100 items

### Current API Call Costs (1000-item collection, cold cache)

| Tool                        | How It Works                       | API Calls | Wall Time (~1.1s/call) |
| --------------------------- | ---------------------------------- | --------- | ---------------------- |
| `search_collection` (plain) | 1 profile + 10 pages               | **11**    | ~12s                   |
| `search_collection` (mood)  | 1 profile + 4 queries x 10 pages   | **41**    | ~45s                   |
| `get_recommendations`       | 1 profile + 10 pages (manual loop) | **11**    | ~12s                   |
| `get_collection_stats`      | 1 profile + 10 pages               | **11**    | ~12s                   |
| `get_release`               | 1 release fetch                    | **1**     | ~1s                    |

A typical conversation (search + stats + recommendations) = **33 calls on cold cache**. A mood search alone = **41 calls**, consuming 68% of the per-minute budget.

### Root Causes

1. **Full-collection pagination on every query-based search** — `searchCollectionWithQuery()` (`src/clients/discogs.ts:373-406`) loops through ALL collection pages for each search. No way around this given the API limitation, but it means collection size directly determines cost.

2. **Mood search expands 1 query into up to 4** — `search_collection` tool (`src/mcp/tools/authenticated.ts:126-166`) generates up to 3 additional mood-based search terms. Each triggers its own full-collection pagination. 4 queries x 10 pages = 40 API calls.

3. **`get_recommendations` duplicates pagination** — (`src/mcp/tools/authenticated.ts:476-501`) manually paginates through the entire collection instead of using `getCompleteCollection()`, which has caching and a `maxPages` safety limit.

4. **Cache keys are per-page, not per-collection** — (`src/clients/cachedDiscogs.ts:57-76`) page 1 and page 2 are cached separately. When `searchCollectionWithQuery` fetches all pages, it generates N separate cache entries rather than caching the complete result set once.

5. **`getCompleteCollection()` exists but is never called** — (`src/clients/cachedDiscogs.ts:189-244`) This method was built for exactly this purpose — fetch all pages, cache the combined result for 45 minutes — but no tool uses it.

6. **`RateLimiter` is dead code** — (`src/utils/rateLimit.ts`) A per-user rate limiter was built and tested, with a KV namespace (`MCP_RL`) provisioned, but it's never imported or used anywhere.

---

## Implementation Plan

### Phase 1: Single-Fetch Collection Architecture

**Goal:** Any tool needing the full collection fetches it exactly once via `getCompleteCollection()`, then all filtering/searching happens in-memory against that cached dataset.

#### 1.1 Enhance `CachedDiscogsClient.getCompleteCollection()`

**File:** `src/clients/cachedDiscogs.ts`

- Increase `maxPages` default from 10 to 25 (supports up to 2500 items)
- Add a `searchInMemory()` method that:
  1. Calls `getCompleteCollection()` (cached, 45-min TTL)
  2. Applies the same client-side filtering logic currently in `DiscogsClient.searchCollectionWithQuery()`
  3. Returns filtered + paginated results
- This becomes the single entry point for all "search within collection" operations

#### 1.2 Refactor `search_collection` tool

**File:** `src/mcp/tools/authenticated.ts` (lines 86-217)

Before:

```
for each searchQuery in [original, mood1, mood2, mood3]:
    client.searchCollection(query=searchQuery)  // each paginates ALL pages
```

After:

```
allReleases = client.getCompleteCollection()  // ONE fetch, cached
for each searchQuery in [original, mood1, mood2, mood3]:
    filterInMemory(allReleases, searchQuery)  // zero API calls
```

**Impact:** Mood search drops from 41 API calls to 11 (cold) or 0 (warm).

#### 1.3 Refactor `get_recommendations` tool

**File:** `src/mcp/tools/authenticated.ts` (lines 476-501)

Replace the manual pagination loop with a single `client.getCompleteCollection()` call. Gets caching + `maxPages` safety for free.

#### 1.4 Refactor `get_collection_stats` tool

**File:** `src/mcp/tools/authenticated.ts` (lines 306-377)

Route through `getCompleteCollection()` instead of `getCollectionStats()` which does its own uncached pagination internally.

#### 1.5 Update MCP resources

**File:** `src/mcp/resources/discogs.ts`

- `discogs://collection` resource should use `getCompleteCollection()`
- `discogs://search?q={query}` resource should use the new in-memory search path

### Expected Impact

| Scenario                                   | Before   | After    |
| ------------------------------------------ | -------- | -------- |
| `search_collection` (mood, cold)           | 41 calls | 11 calls |
| `search_collection` (mood, warm)           | 0        | 0        |
| search + stats + recs (cold)               | 33 calls | 11 calls |
| search + stats + recs (warm)               | 0        | 0        |
| Second mood search, different query (warm) | 41 calls | 0 calls  |

The key insight: after the first tool call fetches the complete collection, **all subsequent tools reuse it from cache** — regardless of what query, filter, or mood is applied. The collection data doesn't change between tool calls in a conversation, so there's no reason to re-fetch it.

---

## Phase 2: Future Work (Not in Scope)

These are noted for future consideration but are not part of this implementation:

- **Wire up `RateLimiter`** — Use the existing (but unused) rate limiter to enforce per-user budgets and fail fast instead of hitting 429s
- **Request budget / circuit breaker** — Cap API calls per tool invocation, return partial results with a note if budget is exhausted
- **Store username in JWT** — Every tool calls `getUserProfile()` just to get the username; storing it in the session token eliminates this call entirely
