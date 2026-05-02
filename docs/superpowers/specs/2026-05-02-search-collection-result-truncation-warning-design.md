# search_collection result-truncation warning — design

**Issue:** [rianvdm/discogs-mcp#20](https://github.com/rianvdm/discogs-mcp/issues/20)
**Date:** 2026-05-02
**Status:** Approved

## Problem

When `search_collection` returns more matches than `per_page`, the response slices to the top N and includes the count in a prefix line ("Found 699 results... showing 100 items"). The calling LLM frequently treats the response as exhaustive and confidently reports that releases not in the visible slice do not exist in the user's collection.

This is the analogue of the existing collection-truncation warning, which fires when the underlying collection cache is incomplete. That warning works well — the LLM picks up on the ⚠️ marker and caveats its answers. The query-result truncation case has no equivalent signal, so partial results read as complete.

## Goals

- Emit a structured warning whenever `allResults.length > finalResults.length` in `search_collection`.
- Use the same shape and placement as the existing `collectionTruncationNote` so calling LLMs treat both as the same class of signal.
- Keep wording actionable for what the tool can do today (narrow the query); leave pagination wording for #19.

## Non-goals

- Pagination support. Tracked in #19; a follow-up will update this warning's wording when that ships.
- Changes to the existing collection-truncation warning.
- Changes to `formatCollectionForSemanticSearch`, which already handles its own capping with a distinct note.
- Any change to ranking, dedup, or filtering behavior.

## Wording

```
⚠️ Showing 100 of 699 matches for "vinyl". Narrow your query (add an artist, genre, or year) to see more specific results.
```

The wording is deliberately actionable today. The literal token "vinyl" in the example is the user's `query` argument. The numeric values are the slice size and the underlying match-set size.

## Architecture

Add a small pure helper in `src/mcp/tools/authenticated.ts` (kept local to the tool file because it is wholly tied to this tool's response shape):

```ts
function buildResultTruncationNote(query: string, found: number, shown: number): string {
  if (found <= shown) return ''
  return `\n\n⚠️ Showing ${shown} of ${found} matches for "${query}". ` +
    `Narrow your query (add an artist, genre, or year) to see more specific results.`
}
```

Both affected call sites use this helper to construct the note string, then append it alongside `collectionTruncationNote` in their final response text.

## Affected call sites

### 1. Best-effort semantic path

Around `authenticated.ts:606–633`. Today it builds:

```
${summary}
${releaseList}${broadSearchHint}${collectionTruncationNote}
```

Becomes:

```
${summary}
${releaseList}${broadSearchHint}${resultTruncationNote}${collectionTruncationNote}
```

`found` = `bestEffortResults.length`, `shown` = `finalResults.length`.

### 2. Main ranked path

Around `authenticated.ts:695–722`. Today it builds:

```
${summary}${temporalInfo}${moodInfo}
${releaseList}

**Tip:** ...${collectionTruncationNote}
```

Becomes:

```
${summary}${temporalInfo}${moodInfo}
${releaseList}

**Tip:** ...${resultTruncationNote}${collectionTruncationNote}
```

`found` = `allResults.length`, `shown` = `finalResults.length`.

### 3. Semantic-fallback (untouched)

`formatCollectionForSemanticSearch` already emits its own capping note (the `cappedNote` line). It uses a different shape (capped LLM dump vs. ranked release list) and a different threshold (750 vs. `per_page`). Leaving it as-is.

## Threshold

Always fire when `found > shown`, with no minimum delta. Even a single hidden release could be the one the user asked about — the entire prior debugging session originated from exactly this scenario.

## Tests

In `test/mcp/tools/searchCollection.test.ts` (or co-located if a closer file exists):

- `buildResultTruncationNote` returns empty string when `found <= shown`.
- `buildResultTruncationNote` returns the exact warning string when `found > shown`, with the query, shown, and found values interpolated correctly.
- Quote handling: a query containing a double quote does not produce a malformed warning. (Worth one assertion since the wording wraps the query in `"..."`.)

No end-to-end integration test for the tool. The helper unit tests plus the existing search-pipeline tests cover the substantive logic; the call-site wiring is a one-line append in two places and is easy to verify by reading the diff.

## Rollout

- Single PR. No feature flag.
- No migration; partial truncation has been silent until now, so adding the warning is purely additive.
- Verify on prod by running a known-broad query (e.g. `search_collection({ query: "vinyl" })`) and confirming the warning appears at the bottom of the response.

## Follow-ups

- #19 (pagination): when it ships, update the helper's wording to mention paginating as a remediation alternative. One-line change; the call sites do not need to be touched again.
