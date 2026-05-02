# search_collection relevance ranking via MiniSearch — design

**Issue:** [rianvdm/discogs-mcp#21](https://github.com/rianvdm/discogs-mcp/issues/21) (v2)
**Date:** 2026-05-02
**Status:** Approved

## Problem

`search_collection` has no notion of match quality. `filterReleasesInMemory` is a hard set-membership filter — a release either matches the query or doesn't, with no scoring of *how well* it matches. After filtering, results are sorted by metadata (mood score, rating, year, date_added) alone.

This produces predictable failures:

- **Recent acquisitions buried** on broad queries like `vinyl`. With moodScore=0 and rating=0 across the board, year-asc tiebreaker puts 1964 records at the top. The 2021 AP Folk Singer reissue ends up at slot ~600.
- **Literal artist+title matches lose to tag matches** on specific queries like `muddy waters folk singer`. A first attempt at fixing this with a date_added desc tiebreaker (committed and reverted) had Muddy Waters' actual *Folk Singer* losing to recently-added random folk-tagged records because all unrated items collide and date_added then dominates.

The first attempt at #21 traded one bad ranking for another. Both are symptoms of the same underlying gap: there is no relevance score for literal matches.

## Goals

- Score every candidate release by how well it matches the query's literal text across artist, title, genre, and style fields.
- Title and artist matches outweigh genre/style tag matches.
- Multi-token literal hits beat single-token tag matches.
- Recent acquisitions still surface near the top when relevance scores tie (the original #21 intent).
- Mood queries keep their existing mood-driven ranking.
- Temporal queries keep their existing date_added bypass.

## Non-goals

- Fuzzy matching beyond the small tolerance MiniSearch provides by default. Discogs metadata is canonical; users typing "muddy" don't usually mean "moody."
- Stemming or synonym expansion. Out of scope for this fix.
- Replacing the mood-scoring pipeline.
- Pagination (#19), cold-cache fetch budget (#18), title-temporal-token bug (#22).

## Approach: MiniSearch

Use [MiniSearch](https://github.com/lucaong/minisearch) for in-memory BM25-style ranking. Verified Workers-compatible: pure ESM, zero deps, 5.7 KB gzipped, MIT, 5.9k stars, current release Sept 2025.

Why a library, not DIY:
- Full-text relevance ranking is a solved problem (BM25, decades of IR research). A hand-rolled scorer recreates classical bugs as we add features.
- Bundle cost trivial relative to the existing 2.5 MB Worker bundle.
- One config object configures field boosting, prefix matching, fuzzy tolerance, phrase queries.
- If MiniSearch goes unmaintained, the integration is small enough (~one config + one query call) to swap in ~a day.

## Architecture

### New module: `src/utils/searchIndex.ts`

```ts
export interface IndexableRelease {
  id: string                       // `${release.id}:${instance_id}` — unique per instance
  release_id: number
  instance_id: number
  title: string
  artist: string
  genres: string                   // joined for indexing
  styles: string                   // joined for indexing
}

export function toIndexable(item: DiscogsCollectionItem): IndexableRelease
export function buildIndex(items: DiscogsCollectionItem[]): MiniSearch<IndexableRelease>
export function searchIndex(
  index: MiniSearch<IndexableRelease>,
  query: string,
): Map<string, number>             // id -> relevance score
```

Field boosts: `title: 3, artist: 2, styles: 1, genres: 1`.
Search options: `combineWith: 'AND', prefix: true, fuzzy: 0.2`.

### Pipeline integration

`applySearchPipeline` in `src/utils/searchRanking.ts` accepts an optional `relevanceScores: Map<string, number>` from the indexer.

- For non-mood, non-temporal queries: relevance score replaces the moodScore-or-zero placeholder. Sort: relevance desc → rating desc → date_added desc → year desc → title alpha → id asc.
- For mood queries: unchanged. Mood score drives sort. Relevance can be ignored.
- For temporal queries: unchanged. date_added wins.

### Tool layer

`search_collection` in `authenticated.ts`:

1. Build (or look up cached) MiniSearch index from `allReleases`.
2. For non-mood, non-temporal queries: run `searchIndex(index, query)` to get scored candidates. Pass scores into `applySearchPipeline`.
3. Mood and temporal paths: unchanged. The existing keyword-filter pipeline still runs because mood expansion needs it.

The semantic-fallback path (`isSemanticQuery` true) and the best-effort partial-match path also stay as they are — they handle queries with no keyword hits by capping the collection for the LLM, which is a different problem.

## Index caching

Naive: rebuild the index on every tool call. With 1,500 records this is ~50–100ms — acceptable but wasteful.

Better: cache the index alongside the existing complete-collection cache. KV stores the *serialized* index (MiniSearch supports `JSON.stringify`/`MiniSearch.loadJSON`). TTL matches the collection cache TTL (4 hours for complete, 30 min for partial). Invalidate together.

For this PR, build per-request. Caching is a follow-up for #18-style work.

## Tests

- Unit tests for `searchIndex`: ranks artist+title matches above tag-only matches; ranks multi-token matches above single-token; returns empty map for queries with no hits.
- Pipeline tests: relevance score wins as primary sort key for non-mood queries; mood queries unaffected; temporal queries unaffected.
- Regression tests:
  - "muddy waters folk singer" ranks Muddy Waters - Folk Singer entries in top 5.
  - "vinyl" surfaces recent vinyl acquisitions when relevance scores tie (the original #21 intent).
  - "mellow jazz" still ranks Kind of Blue above broadly-tagged recent shoegaze (existing #14 mood-query regression test).

## Rollout

- Single PR. No feature flag.
- Verify on prod with `search_collection({ query: "muddy waters folk singer" })` — Muddy Waters entries should be top 5.
- Verify on prod with `search_collection({ query: "vinyl", per_page: 10 })` — recent acquisitions should still surface in top 10 (relevance ties → date_added desc).

## Follow-ups

- Cache the serialized index in KV (#18-adjacent work).
- Once relevance ranking is in place, deprecate the temporal-token heuristic (#22) by requiring an explicit `sort` parameter.
- Pagination (#19).
