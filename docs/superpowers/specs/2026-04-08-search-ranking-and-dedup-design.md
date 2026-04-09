# search_collection ranking and dedup — design

**Issue:** [rianvdm/discogs-mcp#14](https://github.com/rianvdm/discogs-mcp/issues/14)
**Date:** 2026-04-08
**Status:** Approved

## Problem

Three observed ranking/semantics bugs in `search_collection` when run against a real 1510-item collection:

1. **Mood detection overrides explicit query terms.** Query `"mellow jazz for late evening"` returns 8 results with zero Jazz style tags. The mood mapping for "mellow" fires, ORs its suggested styles against the release tags, and ignores the literal "jazz" in the query.
2. **Recency / popularity bias in ranking.** Paul Meany's _Forever Phase_ (2025, Alternative Rock) surfaces in the top 8 for both `"something for a rainy Sunday afternoon"` and `"mellow jazz for late evening"` — two unrelated mood queries. Recent additions to the collection dominate ties.
3. **No dedup of multiple pressings.** Khruangbin's _The Universe Smiles Upon You II_ appears twice in one result set (Vinyl and CD), wasting result slots.

## Root cause

The cached path (always active in production) runs `filterReleasesInMemory` in `src/mcp/tools/authenticated.ts:78`. This function only filters; it has no scoring. After filtering, the sort at `authenticated.ts:687-692` is `rating desc → date_added desc`. With most ratings at 0, `date_added` dominates, so recently-added releases win every tie.

The mood scoring logic in `src/clients/discogs.ts:523-656` is dead code in production — the non-cached path is unreachable once the cached client is instantiated.

The filter itself uses OR logic for mood queries (`moodMatch || termMatch` at `authenticated.ts:232`), which is why explicit genre terms are ignored: a release that matches the mood-expanded set passes even if it has no match for the literal term.

No dedup logic exists at any layer. The seen-set key at `authenticated.ts:648` is `${release.id}-${release.instance_id}`, which correctly dedupes identical instances but not distinct pressings of the same master release.

## Goals

- Explicit genre/style terms act as a hard filter when present in a query.
- Mood matching becomes a soft ranking signal proportional to how tightly a release's tags match the mood, so broadly-tagged recent records don't dominate.
- Results dedupe by Discogs `master_id` with a fallback for masterless releases.
- The sort order is deterministic and free of recency bias for non-temporal queries.
- Dead scoring code in `src/clients/discogs.ts` is removed.

## Non-goals

- Expanding `MOOD_MAPPINGS` vocabulary (separable curation work, no evidence of coverage gaps in the reported cases).
- Touching the semantic search fallback path (`isSemanticQuery` branch).
- Changes to the `filterReleasesInMemory` filter semantics for non-mood queries.
- LLM-based ranking or embeddings. Staying with lexical matching against genre/style tags.

## Architecture

Two new utility modules and one cleanup:

```
src/utils/
  searchQueryParser.ts   ← new
  searchRanking.ts       ← new
  moodMapping.ts         ← unchanged
src/mcp/tools/
  authenticated.ts       ← filterReleasesInMemory calls parser; adds post-filter explicit check, dedup, new sort
src/clients/
  discogs.ts             ← delete dead scoring block at L523-656
```

### `searchQueryParser.ts`

Pure function. Classifies a query once so orchestration can pass the parsed result to both filtering and ranking without re-parsing.

```ts
export interface ParsedQuery {
  filteredQuery: string           // original minus temporal terms
  terms: string[]                 // non-decade terms, length > 2
  decadeTerms: string[]           // e.g. ["1970s"]
  explicitGenreTerms: string[]    // subset of terms found in CONCRETE_GENRES
  isMoodQuery: boolean            // hasMoodContent && confidence >= 0.3
  moodAnalysis: MoodMappingResult | null
  hasRecent: boolean
  hasOld: boolean
}

export function parseSearchQuery(query: string): ParsedQuery
```

`explicitGenreTerms` is computed by intersecting the query terms with `CONCRETE_GENRES` from `moodMapping.ts`. That set is the source of truth for "this word is a genre, not a mood."

### `searchRanking.ts`

Pure functions. Scoring, sorting, and deduplication.

```ts
export interface ScoredRelease {
  item: DiscogsCollectionItem
  moodScore: number               // 0..1, zero for non-mood queries
  explicitMatch: boolean          // satisfied all explicitGenreTerms
}

export interface DedupedCollectionItem extends DiscogsCollectionItem {
  ownedFormats: string[]          // e.g. ["Vinyl", "CD"], freq-desc then alpha
  mergedInstanceIds: number[]     // all instance_ids in the master group
}

export function scoreReleases(
  items: DiscogsCollectionItem[],
  parsed: ParsedQuery
): ScoredRelease[]

export function dedupByMaster(
  scored: ScoredRelease[]
): { item: DedupedCollectionItem; moodScore: number }[]

export function sortScoredReleases(
  deduped: { item: DedupedCollectionItem; moodScore: number }[],
  parsed: ParsedQuery
): DedupedCollectionItem[]
```

### `authenticated.ts` changes

`filterReleasesInMemory` takes an optional `parsed: ParsedQuery` param and skips re-parsing when provided. The search tool's cached path orchestrates the new pipeline.

## Data flow (cached path)

```
1. parsed = parseSearchQuery(query)
2. Build searchQueries (original + mood expansion terms, unchanged from today)
3. For each searchQuery:
     filtered = filterReleasesInMemory(allReleases, searchQuery, options, parsed)
     merge into allResults, dedupe by `${release.id}-${release.instance_id}` (unchanged)
4. IF parsed.explicitGenreTerms.length > 0:
     allResults = allResults.filter(item =>
       parsed.explicitGenreTerms.every(term => releaseMatchesTerm(item, term))
     )
5. scored = scoreReleases(allResults, parsed)
6. deduped = dedupByMaster(scored)
7. sorted = sortScoredReleases(deduped, parsed)
8. finalResults = sorted.slice(0, per_page)
9. Render — show ownedFormats in the Format: line
```

Key flow decisions:

- **Explicit-term hard filter runs AFTER `filterReleasesInMemory`, not inside it.** The existing filter's mood-OR-logic still builds the candidate set for pure-mood queries; we intersect with explicit-term requirements afterward. This leaves the filter untouched for non-mood queries.
- **Dedup runs AFTER scoring but BEFORE sort.** Scoring operates on individual pressings, each of which has its own genre/style data. Dedup then collapses to the representative pressing. Sort operates on the deduped, scored set.
- **Temporal queries (`hasRecent`/`hasOld`) bypass mood scoring AND dedup.** They still sort by `date_added` as today. "Recent additions" should show each pressing you added, not collapse them.
- **Semantic search fallback path is unchanged.**

## Scoring

For mood queries, the moodScore is proportional to how tightly a release's tags match the mood's suggested set, not just whether any match exists.

```
releaseTags   = [...genres, ...styles] lowercased, deduped
suggestedSet  = [...moodAnalysis.suggestedGenres, ...moodAnalysis.suggestedStyles] lowercased
matches       = count of releaseTags that appear in suggestedSet (bidirectional substring match)
moodScore     = matches / max(releaseTags.length, 1)
```

Properties:

- A release tagged only `["Jazz", "Smooth Jazz"]` scores 1.0 for "mellow" — both match.
- A release tagged `["Alternative Rock", "Indie", "Dream Pop", "Shoegaze", "Lo-Fi", "Ambient"]` with one mood match scores ~0.17.
- This directly addresses the Paul Meany case: broadly-tagged recent records get penalized relative to focused releases.

The existing ad-hoc `contextBonus` logic (background/dinner/cooking keyword bumps at `discogs.ts:593-615`) is dropped. It was dead code in production and was fragile. Can be reintroduced later as a separate concern if needed.

Non-mood queries get `moodScore = 0` for all releases and fall through to the tiebreaker chain.

## Dedup

Grouping key:

1. **Prefer `basic_information.master_id`** when present and truthy.
2. **Fallback for masterless releases**: `normalize(artist) + "|" + normalize(title) + "|" + year`. Year is in the key to prevent over-merging a live album with a studio album of the same title.

Normalization: lowercase, strip `[^\w\s]`, collapse whitespace.

Representative pressing selection within a group:

1. Earliest `year` wins.
2. Tiebreak by highest `moodScore` (well-tagged reissue beats a poorly-tagged original for the current query).
3. Tiebreak by stable `release.id` ascending.

The representative inherits:

- `ownedFormats`: union of all `basic_information.formats[].name` across the group, deduped case-insensitively, ordered by frequency descending then alphabetically.
- `mergedInstanceIds`: all instance_ids in the group.
- `moodScore`: MAX across the group (so a well-tagged reissue can boost the representative even if it's not selected as the representative).

The rendered output shows `Format: Vinyl, CD` instead of the single-pressing format.

## Sort order

```
1. moodScore      desc   (nonzero only for mood queries)
2. rating         desc   (user's own rating)
3. year           asc    (earlier = canonical)
4. artist+title   asc    (stable deterministic fallback, case-insensitive)
```

**`date_added` is removed from the general sort chain entirely.** This is the Issue #2 fix. Recency bias is gone for general searches.

Temporal queries (`hasRecent`/`hasOld`) still use `date_added` — that's their explicit purpose — and skip the mood scoring and dedup steps.

## Edge cases

- **Release with zero genres/styles:** `moodScore = 0`, falls through. Guard: `matches / max(releaseTags.length, 1)`.
- **`master_id === 0` or `undefined`:** use the normalized `artist + title + year` fallback key.
- **Artist "Various":** master_id is usually present for compilations, prefer it. Fallback includes year so different Various compilations with the same title stay separate.
- **Query has explicit term but no mood** (e.g. `"jazz 1970s"`): explicit-term filter applies, all mood scores are 0, sort falls through to rating → year → alpha.
- **Mood confidence < 0.3:** parser sets `isMoodQuery = false`, treated as regular query. Existing behavior preserved.
- **No matches after explicit-term filter:** return the empty-result message path. Do not silently fall back to the pre-filter set — the explicit term was user intent.

## Testing

### New unit tests

`test/unit/utils/searchQueryParser.test.ts`:

- Extracts explicit genre terms from `CONCRETE_GENRES`.
- Does not treat mood words as explicit genres.
- Handles compound queries ("mellow jazz", "dark ambient", "chill electronic").
- Temporal + mood combinations ("recent jazz", "old mellow folk").
- Empty and whitespace queries.

`test/unit/utils/searchRanking.test.ts`:

- Given fixture releases tagged `["Jazz", "Smooth Jazz"]`, `["Alternative Rock", "Indie", "Dream Pop", "Ambient", "Shoegaze"]`, and `["Ambient", "Drone"]`, query `"mellow jazz"` → jazz release ranks first; alt-rock and ambient-only are filtered out (no jazz tag).
- Query `"mellow"` (no explicit term) → ranking proportional to mood-tag density; broadly-tagged items score lower.
- Paul-Meany regression: a 5-tag release with one mood match scores below 0.25; a 2-tag release with one mood match scores at least 0.5.
- Deterministic tiebreaker: two identically-scored releases with different years → earlier year wins.
- Alphabetical fallback: same year, same rating → stable artist+title ordering.
- `date_added` does not affect ordering for mood queries.
- `hasRecent` / `hasOld` bypass mood scoring and sort by `date_added`.

`test/unit/utils/searchRanking.dedup.test.ts`:

- Two releases with same `master_id` collapse to one; earliest year is representative.
- Representative inherits MAX mood score from the group.
- `ownedFormats` aggregates across the group (Vinyl + CD → `["Vinyl", "CD"]`).
- `mergedInstanceIds` contains all instance_ids from the group.
- Releases without `master_id` fall back to normalized `artist + title + year` grouping.
- Fallback does not over-merge: live album vs studio album with same artist+title but different year stay separate.
- Different masters never merge even if artist+title happen to match.

### Integration tests (update)

`test/unit/mcp/tools/authenticated.test.ts` (or equivalent):

- Update existing fixtures that assumed `date_added`-based tiebreakers.
- Regression test for Issue #1: fixture with jazz + alt-rock + ambient releases, query `"mellow jazz"`, assert top result has Jazz in genres.
- Regression test for Issue #3: fixture with vinyl+CD of same master, query that returns both, assert result shows one row with `Format: Vinyl, CD`.

## Cleanup

Delete `src/clients/discogs.ts:523-656` — the `ReleaseWithRelevance` scoring + sort block that's unreachable in production. Remove now-unused imports of `hasMoodContent` and `analyzeMoodQuery` in `discogs.ts` if nothing else references them. Run typecheck.

This lands as a separate commit from the feature work.

## Follow-up / out of scope

- **Mood vocabulary expansion.** If post-fix testing surfaces real queries that fail because a mood word isn't mapped, file a separate issue with failing query examples. Expansion is curation work that benefits from real-world signal, not speculation.
- **Reintroducing `contextBonus` (background/dinner/cooking bumps)** if specific regressions emerge. Design it as a data-driven table rather than inline `if (query.includes(...))` branches.
- **LLM-based ranking** stays out of scope. The lexical tag-matching approach is predictable and cheap, and this work establishes the hooks (`searchRanking.ts`) where a smarter scorer could live later.
