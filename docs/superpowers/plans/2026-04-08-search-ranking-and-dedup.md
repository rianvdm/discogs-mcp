# search_collection Ranking and Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs in `search_collection` from [#14](https://github.com/rianvdm/discogs-mcp/issues/14): mood detection overriding explicit query terms, recency bias in ranking, and no dedup of multiple pressings.

**Architecture:** Add two pure utility modules (`searchQueryParser.ts`, `searchRanking.ts`) under `src/utils/`. Parser classifies a query once. Ranking module scores, dedupes by `master_id`, and sorts. The `search_collection` tool in `authenticated.ts` orchestrates the new pipeline after the existing filter pass. Delete dead scoring code in `src/clients/discogs.ts`.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers, Discogs OAuth 1.0a API.

**Spec:** `docs/superpowers/specs/2026-04-08-search-ranking-and-dedup-design.md`

---

## File Structure

**Create:**
- `src/utils/searchQueryParser.ts` — query classification (ParsedQuery)
- `src/utils/searchRanking.ts` — scoring, dedup, sort, pipeline orchestration
- `test/utils/searchQueryParser.test.ts`
- `test/utils/searchRanking.test.ts`
- `test/mcp/tools/searchCollectionRanking.test.ts` — end-to-end ranking regression for the three reported bugs

**Modify:**
- `src/utils/moodMapping.ts` — export `CONCRETE_GENRES`
- `src/clients/discogs.ts` — add `master_id?: number` to `DiscogsCollectionItem.basic_information` type; delete dead scoring code at L523-656
- `src/mcp/tools/authenticated.ts` — `filterReleasesInMemory` accepts optional parsed query; `search_collection` tool handler wires in the new pipeline; render line includes aggregated formats

---

## Task 1: Prep — export CONCRETE_GENRES and add master_id to type

**Files:**
- Modify: `src/utils/moodMapping.ts:315`
- Modify: `src/clients/discogs.ts:48-77`

- [ ] **Step 1: Export `CONCRETE_GENRES` from moodMapping.ts**

Change `src/utils/moodMapping.ts:315` from:

```ts
const CONCRETE_GENRES = new Set([
```

to:

```ts
export const CONCRETE_GENRES = new Set([
```

- [ ] **Step 2: Add `master_id` to `DiscogsCollectionItem.basic_information`**

In `src/clients/discogs.ts`, modify the interface at lines 48-77. Add `master_id?: number` and `master_url?: string` inside `basic_information`. The Discogs Collection API returns these; the type was missing them.

```ts
export interface DiscogsCollectionItem {
	id: number
	instance_id: number
	folder_id?: number
	date_added: string
	rating: number
	basic_information: {
		id: number
		master_id?: number
		master_url?: string
		title: string
		year: number
		resource_url: string
		thumb: string
		cover_image: string
		formats: Array<{
			name: string
			qty: string
			descriptions?: string[]
		}>
		labels: Array<{
			name: string
			catno: string
		}>
		artists: Array<{
			name: string
			id: number
		}>
		genres: string[]
		styles: string[]
	}
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 4: Run existing tests**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run`
Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
git add src/utils/moodMapping.ts src/clients/discogs.ts
git commit -m "chore: export CONCRETE_GENRES and add master_id to collection item type"
```

---

## Task 2: searchQueryParser — failing tests

**Files:**
- Create: `test/utils/searchQueryParser.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `test/utils/searchQueryParser.test.ts` with this exact content:

```ts
import { describe, it, expect } from 'vitest'
import { parseSearchQuery } from '../../src/utils/searchQueryParser'

describe('parseSearchQuery', () => {
	it('extracts explicit genre terms from CONCRETE_GENRES', () => {
		const parsed = parseSearchQuery('mellow jazz for late evening')
		expect(parsed.explicitGenreTerms).toContain('jazz')
		expect(parsed.isMoodQuery).toBe(true)
	})

	it('does not treat mood words as explicit genres', () => {
		const parsed = parseSearchQuery('mellow vibes')
		expect(parsed.explicitGenreTerms).toEqual([])
		expect(parsed.isMoodQuery).toBe(true)
	})

	it('handles multiple explicit genres in one query', () => {
		const parsed = parseSearchQuery('jazz and folk')
		expect(parsed.explicitGenreTerms).toEqual(expect.arrayContaining(['jazz', 'folk']))
	})

	it('strips temporal terms from filteredQuery', () => {
		const parsed = parseSearchQuery('recent jazz')
		expect(parsed.hasRecent).toBe(true)
		expect(parsed.filteredQuery).toBe('jazz')
		expect(parsed.explicitGenreTerms).toEqual(['jazz'])
	})

	it('detects old temporal terms', () => {
		const parsed = parseSearchQuery('oldest mellow folk')
		expect(parsed.hasOld).toBe(true)
		expect(parsed.filteredQuery).toBe('mellow folk')
	})

	it('extracts decade terms separately from non-decade terms', () => {
		const parsed = parseSearchQuery('jazz 1970s')
		expect(parsed.decadeTerms).toEqual(['1970s'])
		expect(parsed.terms).toEqual(['jazz'])
	})

	it('returns empty parsed query for whitespace input', () => {
		const parsed = parseSearchQuery('   ')
		expect(parsed.filteredQuery).toBe('')
		expect(parsed.terms).toEqual([])
		expect(parsed.isMoodQuery).toBe(false)
	})

	it('sets isMoodQuery false when mood confidence is below 0.3', () => {
		// "Sunday" alone is a contextual cue with weight 0.5 but no mood → confidence 0.5
		// "evening" alone is context only — check that plain non-mood queries return false
		const parsed = parseSearchQuery('Miles Davis')
		expect(parsed.isMoodQuery).toBe(false)
		expect(parsed.moodAnalysis).toBeNull()
	})

	it('populates moodAnalysis when mood is detected', () => {
		const parsed = parseSearchQuery('mellow jazz')
		expect(parsed.moodAnalysis).not.toBeNull()
		expect(parsed.moodAnalysis!.detectedMoods).toContain('mellow')
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchQueryParser.test.ts`
Expected: FAIL with "Cannot find module '../../src/utils/searchQueryParser'"

---

## Task 3: searchQueryParser — implementation

**Files:**
- Create: `src/utils/searchQueryParser.ts`

- [ ] **Step 1: Create the module**

Create `src/utils/searchQueryParser.ts` with this content:

```ts
/**
 * Parse and classify a search query once so filtering, scoring, and
 * orchestration can share the same result without re-parsing.
 */

import { analyzeMoodQuery, hasMoodContent, CONCRETE_GENRES, type MoodMappingResult } from './moodMapping'

export interface ParsedQuery {
	/** Original query with temporal terms removed. Lowercased. */
	filteredQuery: string
	/** Non-decade terms, length > 2. Lowercased. */
	terms: string[]
	/** Decade terms like "1970s". */
	decadeTerms: string[]
	/** Subset of `terms` that are in CONCRETE_GENRES. Acts as a hard filter. */
	explicitGenreTerms: string[]
	/** True when hasMoodContent is true AND confidence >= 0.3. */
	isMoodQuery: boolean
	moodAnalysis: MoodMappingResult | null
	hasRecent: boolean
	hasOld: boolean
}

const TEMPORAL_TERMS = new Set(['recent', 'recently', 'new', 'newest', 'latest', 'old', 'oldest', 'earliest'])
const RECENT_TERMS = new Set(['recent', 'recently', 'new', 'newest', 'latest'])
const OLD_TERMS = new Set(['old', 'oldest', 'earliest'])
const MOOD_CONFIDENCE_THRESHOLD = 0.3

export function parseSearchQuery(query: string): ParsedQuery {
	const lowered = query.toLowerCase()
	const words = lowered.split(/\s+/).filter((w) => w.length > 0)

	const hasRecent = words.some((w) => RECENT_TERMS.has(w))
	const hasOld = words.some((w) => OLD_TERMS.has(w))

	const filteredWords = words.filter((w) => !TEMPORAL_TERMS.has(w))
	const filteredQuery = filteredWords.join(' ')

	const queryTerms = filteredWords.filter((t) => t.length > 2)
	const decadeTerms: string[] = []
	const terms: string[] = []
	for (const term of queryTerms) {
		if (/^\d{4}s$/.test(term)) {
			decadeTerms.push(term)
		} else {
			terms.push(term)
		}
	}

	const explicitGenreTerms = terms.filter((t) => CONCRETE_GENRES.has(t))

	let isMoodQuery = false
	let moodAnalysis: MoodMappingResult | null = null
	if (filteredQuery && hasMoodContent(filteredQuery)) {
		const analysis = analyzeMoodQuery(filteredQuery)
		if (analysis.confidence >= MOOD_CONFIDENCE_THRESHOLD) {
			isMoodQuery = true
			moodAnalysis = analysis
		}
	}

	return {
		filteredQuery,
		terms,
		decadeTerms,
		explicitGenreTerms,
		isMoodQuery,
		moodAnalysis,
		hasRecent,
		hasOld,
	}
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchQueryParser.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
git add src/utils/searchQueryParser.ts test/utils/searchQueryParser.test.ts
git commit -m "feat(search): add searchQueryParser for one-time query classification"
```

---

## Task 4: searchRanking.scoreReleases — failing tests

**Files:**
- Create: `test/utils/searchRanking.test.ts`

- [ ] **Step 1: Create the test file with fixture factory and scoring tests**

Create `test/utils/searchRanking.test.ts` with this content:

```ts
import { describe, it, expect } from 'vitest'
import { scoreReleases, dedupByMaster, sortScoredReleases, applySearchPipeline } from '../../src/utils/searchRanking'
import { parseSearchQuery } from '../../src/utils/searchQueryParser'
import type { DiscogsCollectionItem } from '../../src/clients/discogs'

type FixtureArgs = {
	id: number
	instance_id?: number
	title: string
	artist: string
	year: number
	genres: string[]
	styles: string[]
	formats?: string[]
	rating?: number
	master_id?: number
	date_added?: string
}

function release(args: FixtureArgs): DiscogsCollectionItem {
	return {
		id: args.id,
		instance_id: args.instance_id ?? args.id * 1000,
		date_added: args.date_added ?? '2020-01-01T00:00:00-00:00',
		rating: args.rating ?? 0,
		basic_information: {
			id: args.id,
			master_id: args.master_id,
			title: args.title,
			year: args.year,
			resource_url: '',
			thumb: '',
			cover_image: '',
			formats: (args.formats ?? ['Vinyl']).map((name) => ({ name, qty: '1' })),
			labels: [],
			artists: [{ name: args.artist, id: 1 }],
			genres: args.genres,
			styles: args.styles,
		},
	}
}

describe('scoreReleases', () => {
	it('scores focused jazz release highest for "mellow" mood', () => {
		const items = [
			release({ id: 1, title: 'Kind of Blue', artist: 'Miles Davis', year: 1959, genres: ['Jazz'], styles: ['Modal'] }),
			release({
				id: 2,
				title: 'Forever Phase',
				artist: 'Paul Meany',
				year: 2025,
				genres: ['Rock'],
				styles: ['Alternative Rock', 'Indie Rock', 'Dream Pop', 'Shoegaze', 'Lo-Fi'],
			}),
		]
		const parsed = parseSearchQuery('mellow')
		const scored = scoreReleases(items, parsed)
		const kindOfBlue = scored.find((s) => s.item.id === 1)!
		const foreverPhase = scored.find((s) => s.item.id === 2)!
		expect(kindOfBlue.moodScore).toBeGreaterThan(foreverPhase.moodScore)
	})

	it('gives a broadly-tagged release with one mood match a score below 0.25', () => {
		const items = [
			release({
				id: 1,
				title: 'Broad',
				artist: 'Band',
				year: 2025,
				genres: ['Rock'],
				styles: ['Alternative Rock', 'Indie Rock', 'Dream Pop', 'Shoegaze', 'Lo-Fi'],
			}),
		]
		const parsed = parseSearchQuery('mellow')
		const scored = scoreReleases(items, parsed)
		expect(scored[0].moodScore).toBeLessThan(0.25)
	})

	it('gives a focused 2-tag release with one mood match a score of at least 0.5', () => {
		const items = [
			release({ id: 1, title: 'Focused', artist: 'Band', year: 1975, genres: ['Jazz'], styles: ['Smooth Jazz'] }),
		]
		const parsed = parseSearchQuery('mellow')
		const scored = scoreReleases(items, parsed)
		expect(scored[0].moodScore).toBeGreaterThanOrEqual(0.5)
	})

	it('returns zero moodScore for non-mood queries', () => {
		const items = [release({ id: 1, title: 'A', artist: 'B', year: 2000, genres: ['Rock'], styles: ['Classic Rock'] })]
		const parsed = parseSearchQuery('rock')
		const scored = scoreReleases(items, parsed)
		expect(scored[0].moodScore).toBe(0)
	})

	it('handles zero-genre releases without dividing by zero', () => {
		const items = [release({ id: 1, title: 'A', artist: 'B', year: 2000, genres: [], styles: [] })]
		const parsed = parseSearchQuery('mellow')
		const scored = scoreReleases(items, parsed)
		expect(scored[0].moodScore).toBe(0)
	})

	it('sets explicitMatch true only when all explicit terms match', () => {
		const items = [
			release({ id: 1, title: 'A', artist: 'B', year: 2000, genres: ['Jazz'], styles: ['Smooth Jazz'] }),
			release({ id: 2, title: 'C', artist: 'D', year: 2000, genres: ['Rock'], styles: ['Dream Pop'] }),
		]
		const parsed = parseSearchQuery('mellow jazz')
		const scored = scoreReleases(items, parsed)
		expect(scored.find((s) => s.item.id === 1)!.explicitMatch).toBe(true)
		expect(scored.find((s) => s.item.id === 2)!.explicitMatch).toBe(false)
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchRanking.test.ts`
Expected: FAIL with "Cannot find module '../../src/utils/searchRanking'"

---

## Task 5: searchRanking — scoreReleases implementation

**Files:**
- Create: `src/utils/searchRanking.ts`

- [ ] **Step 1: Create the module with scoreReleases and the supporting types**

Create `src/utils/searchRanking.ts` with this content:

```ts
/**
 * Score, dedup, and sort search candidates.
 *
 * Pure functions only. All inputs are DiscogsCollectionItem[] + ParsedQuery.
 * No I/O, no network, no mutation of inputs.
 */

import type { DiscogsCollectionItem } from '../clients/discogs'
import type { ParsedQuery } from './searchQueryParser'

export interface ScoredRelease {
	item: DiscogsCollectionItem
	/** 0..1, nonzero only for mood queries. */
	moodScore: number
	/** True when all parsed.explicitGenreTerms appear in the release text. */
	explicitMatch: boolean
}

export interface DedupedCollectionItem extends DiscogsCollectionItem {
	/** Union of formats across the master group, freq-desc then alpha. */
	ownedFormats: string[]
	/** All instance_ids in the master group. */
	mergedInstanceIds: number[]
}

export interface ScoredDedupedRelease {
	item: DedupedCollectionItem
	/** MAX moodScore across the master group. */
	moodScore: number
}

/**
 * Build the searchable text blob for an item (lowercased, genres + styles + artists + title).
 */
function releaseText(item: DiscogsCollectionItem): string {
	const info = item.basic_information
	const parts = [
		info.title,
		...(info.artists?.map((a) => a.name) || []),
		...(info.genres || []),
		...(info.styles || []),
	]
	return parts.join(' ').toLowerCase()
}

/**
 * Check whether a release satisfies a single explicit term.
 * Matches against the concatenation of artist + title + genres + styles.
 */
export function releaseMatchesTerm(item: DiscogsCollectionItem, term: string): boolean {
	return releaseText(item).includes(term.toLowerCase())
}

/**
 * Score each release for the given parsed query.
 * moodScore = matches / max(releaseTags.length, 1) where releaseTags = genres ∪ styles.
 */
export function scoreReleases(items: DiscogsCollectionItem[], parsed: ParsedQuery): ScoredRelease[] {
	const suggestedSet =
		parsed.isMoodQuery && parsed.moodAnalysis
			? new Set(
					[...parsed.moodAnalysis.suggestedGenres, ...parsed.moodAnalysis.suggestedStyles].map((s) => s.toLowerCase()),
				)
			: null

	return items.map((item) => {
		const info = item.basic_information
		const releaseTags = [...(info.genres || []), ...(info.styles || [])].map((t) => t.toLowerCase())
		const uniqueTags = Array.from(new Set(releaseTags))

		let moodScore = 0
		if (suggestedSet) {
			let matches = 0
			for (const tag of uniqueTags) {
				for (const suggested of suggestedSet) {
					if (tag.includes(suggested) || suggested.includes(tag)) {
						matches++
						break
					}
				}
			}
			moodScore = matches / Math.max(uniqueTags.length, 1)
		}

		const explicitMatch =
			parsed.explicitGenreTerms.length === 0 ||
			parsed.explicitGenreTerms.every((term) => releaseMatchesTerm(item, term))

		return { item, moodScore, explicitMatch }
	})
}

// Stubs for following tasks — implemented in Tasks 7 and 9.
export function dedupByMaster(_scored: ScoredRelease[]): ScoredDedupedRelease[] {
	throw new Error('not implemented')
}

export function sortScoredReleases(
	_deduped: ScoredDedupedRelease[],
	_parsed: ParsedQuery,
): DedupedCollectionItem[] {
	throw new Error('not implemented')
}

export function applySearchPipeline(
	_items: DiscogsCollectionItem[],
	_parsed: ParsedQuery,
): DedupedCollectionItem[] {
	throw new Error('not implemented')
}
```

- [ ] **Step 2: Run scoring tests to verify they pass**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchRanking.test.ts -t "scoreReleases"`
Expected: PASS (6 tests).

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
git add src/utils/searchRanking.ts test/utils/searchRanking.test.ts
git commit -m "feat(search): add scoreReleases with proportional mood scoring"
```

---

## Task 6: dedupByMaster — failing tests

**Files:**
- Modify: `test/utils/searchRanking.test.ts`

- [ ] **Step 1: Append the dedup test suite**

Append this block to `test/utils/searchRanking.test.ts` (after the `scoreReleases` describe block, before the file ends):

```ts
describe('dedupByMaster', () => {
	it('collapses two releases with same master_id to one row', () => {
		const items = [
			release({
				id: 10,
				title: 'Universe Smiles',
				artist: 'Khruangbin',
				year: 2015,
				master_id: 999,
				genres: ['Jazz'],
				styles: ['Psychedelic'],
				formats: ['Vinyl'],
			}),
			release({
				id: 11,
				title: 'Universe Smiles',
				artist: 'Khruangbin',
				year: 2018,
				master_id: 999,
				genres: ['Jazz'],
				styles: ['Psychedelic'],
				formats: ['CD'],
			}),
		]
		const parsed = parseSearchQuery('mellow jazz')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		expect(deduped).toHaveLength(1)
	})

	it('picks earliest year as representative', () => {
		const items = [
			release({ id: 11, title: 'A', artist: 'B', year: 2018, master_id: 999, genres: ['Jazz'], styles: [] }),
			release({ id: 10, title: 'A', artist: 'B', year: 2015, master_id: 999, genres: ['Jazz'], styles: [] }),
		]
		const parsed = parseSearchQuery('jazz')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		expect(deduped[0].item.basic_information.year).toBe(2015)
		expect(deduped[0].item.id).toBe(10)
	})

	it('aggregates ownedFormats freq-desc then alpha', () => {
		const items = [
			release({ id: 10, title: 'A', artist: 'B', year: 2015, master_id: 999, genres: [], styles: [], formats: ['Vinyl'] }),
			release({ id: 11, title: 'A', artist: 'B', year: 2018, master_id: 999, genres: [], styles: [], formats: ['CD'] }),
			release({ id: 12, title: 'A', artist: 'B', year: 2019, master_id: 999, genres: [], styles: [], formats: ['Vinyl'] }),
		]
		const scored = scoreReleases(items, parseSearchQuery('anything'))
		const deduped = dedupByMaster(scored)
		expect(deduped[0].item.ownedFormats).toEqual(['Vinyl', 'CD'])
	})

	it('populates mergedInstanceIds with all instance_ids in the group', () => {
		const items = [
			release({ id: 10, instance_id: 100, title: 'A', artist: 'B', year: 2015, master_id: 999, genres: [], styles: [] }),
			release({ id: 11, instance_id: 200, title: 'A', artist: 'B', year: 2018, master_id: 999, genres: [], styles: [] }),
		]
		const scored = scoreReleases(items, parseSearchQuery('anything'))
		const deduped = dedupByMaster(scored)
		expect(deduped[0].item.mergedInstanceIds).toEqual(expect.arrayContaining([100, 200]))
		expect(deduped[0].item.mergedInstanceIds).toHaveLength(2)
	})

	it('representative inherits MAX moodScore from the group', () => {
		const items = [
			release({ id: 10, title: 'A', artist: 'B', year: 2015, master_id: 999, genres: ['Rock'], styles: [] }),
			release({ id: 11, title: 'A', artist: 'B', year: 2018, master_id: 999, genres: ['Jazz'], styles: ['Smooth Jazz'] }),
		]
		const parsed = parseSearchQuery('mellow')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const rep = deduped.find((d) => d.item.basic_information.year === 2015)!
		// Reissue (id 11) has higher mood score; representative (id 10) inherits it.
		expect(rep.moodScore).toBeGreaterThan(0)
	})

	it('falls back to artist+title+year when master_id is missing', () => {
		const items = [
			release({ id: 20, title: 'Live at X', artist: 'Band', year: 1975, genres: [], styles: [] }),
			release({ id: 21, title: 'Live at X', artist: 'Band', year: 2020, genres: [], styles: [] }),
		]
		const scored = scoreReleases(items, parseSearchQuery('anything'))
		const deduped = dedupByMaster(scored)
		// Different years → not merged (prevents over-merging live vs studio).
		expect(deduped).toHaveLength(2)
	})

	it('fallback merges same artist+title+year with no master_id', () => {
		const items = [
			release({ id: 20, instance_id: 200, title: 'X', artist: 'Band', year: 1975, genres: [], styles: [], formats: ['Vinyl'] }),
			release({ id: 21, instance_id: 201, title: 'X', artist: 'Band', year: 1975, genres: [], styles: [], formats: ['CD'] }),
		]
		const scored = scoreReleases(items, parseSearchQuery('anything'))
		const deduped = dedupByMaster(scored)
		expect(deduped).toHaveLength(1)
		expect(deduped[0].item.ownedFormats).toEqual(['CD', 'Vinyl'])
	})

	it('does not merge different master_ids with same artist+title', () => {
		const items = [
			release({ id: 10, title: 'Greatest Hits', artist: 'Band', year: 2000, master_id: 100, genres: [], styles: [] }),
			release({ id: 11, title: 'Greatest Hits', artist: 'Band', year: 2010, master_id: 200, genres: [], styles: [] }),
		]
		const scored = scoreReleases(items, parseSearchQuery('anything'))
		const deduped = dedupByMaster(scored)
		expect(deduped).toHaveLength(2)
	})
})
```

- [ ] **Step 2: Run dedup tests to verify they fail**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchRanking.test.ts -t "dedupByMaster"`
Expected: FAIL with "not implemented".

---

## Task 7: dedupByMaster — implementation

**Files:**
- Modify: `src/utils/searchRanking.ts`

- [ ] **Step 1: Replace the dedupByMaster stub with the real implementation**

In `src/utils/searchRanking.ts`, replace the stub `export function dedupByMaster(_scored: ScoredRelease[]): ScoredDedupedRelease[]` with:

```ts
/**
 * Normalize a string for fallback grouping when master_id is missing.
 * Lowercase, strip non-word-or-space, collapse whitespace.
 */
function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\w\s]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Build the grouping key for a release.
 * Prefers basic_information.master_id; falls back to normalized artist+title+year.
 */
function groupKey(item: DiscogsCollectionItem): string {
	const info = item.basic_information
	if (info.master_id && info.master_id > 0) {
		return `master:${info.master_id}`
	}
	const artist = normalize(info.artists?.[0]?.name ?? '')
	const title = normalize(info.title ?? '')
	return `fallback:${artist}|${title}|${info.year ?? 0}`
}

/**
 * Aggregate format names across a group, ordered by frequency desc then alpha.
 */
function aggregateFormats(group: ScoredRelease[]): string[] {
	const counts = new Map<string, number>()
	for (const { item } of group) {
		const seenInThisItem = new Set<string>()
		for (const f of item.basic_information.formats || []) {
			const key = f.name
			if (seenInThisItem.has(key.toLowerCase())) continue
			seenInThisItem.add(key.toLowerCase())
			counts.set(key, (counts.get(key) ?? 0) + 1)
		}
	}
	return Array.from(counts.entries())
		.sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1]
			return a[0].localeCompare(b[0])
		})
		.map(([name]) => name)
}

/**
 * Collapse scored releases into one row per master group.
 * Representative = earliest year, tiebreak by highest moodScore, then lowest release.id.
 * The representative inherits MAX moodScore across the group.
 */
export function dedupByMaster(scored: ScoredRelease[]): ScoredDedupedRelease[] {
	const groups = new Map<string, ScoredRelease[]>()
	for (const s of scored) {
		const key = groupKey(s.item)
		const existing = groups.get(key)
		if (existing) {
			existing.push(s)
		} else {
			groups.set(key, [s])
		}
	}

	const result: ScoredDedupedRelease[] = []
	for (const group of groups.values()) {
		// Sort to find representative.
		const sorted = [...group].sort((a, b) => {
			const yearA = a.item.basic_information.year ?? Number.MAX_SAFE_INTEGER
			const yearB = b.item.basic_information.year ?? Number.MAX_SAFE_INTEGER
			if (yearA !== yearB) return yearA - yearB
			if (b.moodScore !== a.moodScore) return b.moodScore - a.moodScore
			return a.item.id - b.item.id
		})
		const representative = sorted[0]
		const maxMoodScore = Math.max(...group.map((g) => g.moodScore))
		const mergedInstanceIds = group.map((g) => g.item.instance_id)
		const ownedFormats = aggregateFormats(group)

		const dedupedItem: DedupedCollectionItem = {
			...representative.item,
			ownedFormats,
			mergedInstanceIds,
		}
		result.push({ item: dedupedItem, moodScore: maxMoodScore })
	}
	return result
}
```

- [ ] **Step 2: Run dedup tests to verify they pass**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchRanking.test.ts -t "dedupByMaster"`
Expected: PASS (8 tests).

- [ ] **Step 3: Run full ranking test file to confirm no regressions**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchRanking.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 4: Commit**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
git add src/utils/searchRanking.ts test/utils/searchRanking.test.ts
git commit -m "feat(search): add dedupByMaster for master_id grouping with fallback"
```

---

## Task 8: sortScoredReleases + applySearchPipeline — failing tests

**Files:**
- Modify: `test/utils/searchRanking.test.ts`

- [ ] **Step 1: Append the sort and pipeline test suites**

Append this block to `test/utils/searchRanking.test.ts`:

```ts
describe('sortScoredReleases', () => {
	it('sorts by moodScore desc for mood queries', () => {
		const items = [
			release({ id: 1, title: 'Low', artist: 'A', year: 2000, genres: ['Rock'], styles: ['Alt', 'Indie', 'Dream', 'Shoe', 'Lo-Fi'] }),
			release({ id: 2, title: 'High', artist: 'B', year: 2000, genres: ['Jazz'], styles: ['Smooth Jazz'] }),
		]
		const parsed = parseSearchQuery('mellow')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed)
		expect(sorted[0].id).toBe(2)
	})

	it('tiebreaks by rating desc, then year asc, then artist+title alpha', () => {
		const items = [
			release({ id: 1, title: 'Z', artist: 'Z', year: 2005, rating: 3, genres: [], styles: [] }),
			release({ id: 2, title: 'A', artist: 'A', year: 2000, rating: 3, genres: [], styles: [] }),
			release({ id: 3, title: 'M', artist: 'M', year: 2000, rating: 5, genres: [], styles: [] }),
			release({ id: 4, title: 'K', artist: 'K', year: 2000, rating: 3, genres: [], styles: [] }),
		]
		const parsed = parseSearchQuery('anything')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed)
		// rating 5 first
		expect(sorted[0].id).toBe(3)
		// then rating 3, year 2000: ids 2 and 4. Alpha: "A - A" < "K - K" < "Z - Z"
		expect(sorted[1].id).toBe(2)
		expect(sorted[2].id).toBe(4)
		// then rating 3, year 2005: id 1
		expect(sorted[3].id).toBe(1)
	})

	it('ignores date_added as a tiebreaker for non-temporal queries', () => {
		const items = [
			release({ id: 1, title: 'A', artist: 'A', year: 2000, rating: 0, date_added: '2020-01-01T00:00:00-00:00', genres: [], styles: [] }),
			release({ id: 2, title: 'A', artist: 'A', year: 2000, rating: 0, date_added: '2026-01-01T00:00:00-00:00', master_id: 500, genres: [], styles: [] }),
		]
		const parsed = parseSearchQuery('anything')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed)
		// Both same rating/year/artist/title → stable by id. date_added should not matter.
		// If date_added were the tiebreaker, id 2 (newer) would come first.
		expect(sorted[0].id).toBe(1)
	})

	it('sorts by date_added desc when hasRecent', () => {
		const items = [
			release({ id: 1, title: 'A', artist: 'A', year: 2000, date_added: '2020-01-01T00:00:00-00:00', genres: [], styles: [] }),
			release({ id: 2, title: 'B', artist: 'B', year: 2000, date_added: '2026-01-01T00:00:00-00:00', genres: [], styles: [] }),
		]
		const parsed = parseSearchQuery('recent')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed)
		expect(sorted[0].id).toBe(2)
	})

	it('sorts by date_added asc when hasOld', () => {
		const items = [
			release({ id: 1, title: 'A', artist: 'A', year: 2000, date_added: '2020-01-01T00:00:00-00:00', genres: [], styles: [] }),
			release({ id: 2, title: 'B', artist: 'B', year: 2000, date_added: '2026-01-01T00:00:00-00:00', genres: [], styles: [] }),
		]
		const parsed = parseSearchQuery('oldest')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed)
		expect(sorted[0].id).toBe(1)
	})
})

describe('applySearchPipeline', () => {
	it('Issue #1 regression: mellow jazz filters out non-jazz releases', () => {
		const items = [
			release({ id: 1, title: 'Ambient Record', artist: 'Stars', year: 2005, genres: ['Ambient'], styles: ['Drone'] }),
			release({
				id: 2,
				title: 'Forever Phase',
				artist: 'Paul Meany',
				year: 2025,
				genres: ['Rock'],
				styles: ['Alternative Rock', 'Indie', 'Dream Pop', 'Shoegaze', 'Lo-Fi'],
			}),
			release({ id: 3, title: 'Kind of Blue', artist: 'Miles Davis', year: 1959, genres: ['Jazz'], styles: ['Modal'] }),
		]
		const parsed = parseSearchQuery('mellow jazz')
		const result = applySearchPipeline(items, parsed)
		// Only the jazz release survives the explicit-term filter.
		expect(result).toHaveLength(1)
		expect(result[0].id).toBe(3)
	})

	it('Issue #3 regression: dedups vinyl + CD of same master into one row with aggregated formats', () => {
		const items = [
			release({
				id: 10,
				title: 'Universe Smiles',
				artist: 'Khruangbin',
				year: 2015,
				master_id: 999,
				genres: ['Jazz'],
				styles: [],
				formats: ['Vinyl'],
			}),
			release({
				id: 11,
				title: 'Universe Smiles',
				artist: 'Khruangbin',
				year: 2018,
				master_id: 999,
				genres: ['Jazz'],
				styles: [],
				formats: ['CD'],
			}),
		]
		const parsed = parseSearchQuery('jazz')
		const result = applySearchPipeline(items, parsed)
		expect(result).toHaveLength(1)
		expect(result[0].ownedFormats).toEqual(expect.arrayContaining(['Vinyl', 'CD']))
	})

	it('Issue #2 regression: recent alt-rock does not outrank focused jazz for mood query', () => {
		const items = [
			release({
				id: 1,
				title: 'Forever Phase',
				artist: 'Paul Meany',
				year: 2025,
				rating: 0,
				date_added: '2026-03-01T00:00:00-00:00',
				genres: ['Rock'],
				// 5 styles, only "Dream Pop" might mood-match
				styles: ['Alternative Rock', 'Indie', 'Dream Pop', 'Shoegaze', 'Lo-Fi'],
			}),
			release({
				id: 2,
				title: 'Kind of Blue',
				artist: 'Miles Davis',
				year: 1959,
				rating: 0,
				date_added: '2015-01-01T00:00:00-00:00',
				genres: ['Jazz'],
				styles: ['Smooth Jazz'],
			}),
		]
		const parsed = parseSearchQuery('mellow')
		const result = applySearchPipeline(items, parsed)
		expect(result[0].id).toBe(2)
	})

	it('skips dedup and scoring for temporal queries', () => {
		const items = [
			release({
				id: 10,
				title: 'A',
				artist: 'B',
				year: 2015,
				master_id: 999,
				date_added: '2020-01-01T00:00:00-00:00',
				genres: [],
				styles: [],
				formats: ['Vinyl'],
			}),
			release({
				id: 11,
				title: 'A',
				artist: 'B',
				year: 2018,
				master_id: 999,
				date_added: '2026-01-01T00:00:00-00:00',
				genres: [],
				styles: [],
				formats: ['CD'],
			}),
		]
		const parsed = parseSearchQuery('recent')
		const result = applySearchPipeline(items, parsed)
		// Both kept, newest first.
		expect(result).toHaveLength(2)
		expect(result[0].id).toBe(11)
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchRanking.test.ts -t "sortScoredReleases"`
Expected: FAIL with "not implemented".

---

## Task 9: sortScoredReleases + applySearchPipeline — implementation

**Files:**
- Modify: `src/utils/searchRanking.ts`

- [ ] **Step 1: Replace the sortScoredReleases and applySearchPipeline stubs**

In `src/utils/searchRanking.ts`, replace both stubs with:

```ts
function artistTitleKey(item: DedupedCollectionItem): string {
	const info = item.basic_information
	const artist = (info.artists?.[0]?.name ?? '').toLowerCase()
	const title = (info.title ?? '').toLowerCase()
	return `${artist} - ${title}`
}

/**
 * Order: moodScore desc → rating desc → year asc → artist+title alpha → id asc.
 * date_added is intentionally NOT a tiebreaker for general queries.
 * For hasRecent/hasOld, sort by date_added only.
 */
export function sortScoredReleases(
	deduped: ScoredDedupedRelease[],
	parsed: ParsedQuery,
): DedupedCollectionItem[] {
	const copy = [...deduped]

	if (parsed.hasRecent) {
		copy.sort(
			(a, b) => new Date(b.item.date_added).getTime() - new Date(a.item.date_added).getTime(),
		)
		return copy.map((s) => s.item)
	}
	if (parsed.hasOld) {
		copy.sort(
			(a, b) => new Date(a.item.date_added).getTime() - new Date(b.item.date_added).getTime(),
		)
		return copy.map((s) => s.item)
	}

	copy.sort((a, b) => {
		if (b.moodScore !== a.moodScore) return b.moodScore - a.moodScore
		if (b.item.rating !== a.item.rating) return b.item.rating - a.item.rating
		const yearA = a.item.basic_information.year ?? Number.MAX_SAFE_INTEGER
		const yearB = b.item.basic_information.year ?? Number.MAX_SAFE_INTEGER
		if (yearA !== yearB) return yearA - yearB
		const keyA = artistTitleKey(a.item)
		const keyB = artistTitleKey(b.item)
		if (keyA !== keyB) return keyA.localeCompare(keyB)
		return a.item.id - b.item.id
	})
	return copy.map((s) => s.item)
}

/**
 * End-to-end ranking pipeline.
 *
 * 1. Apply explicit-term hard filter (Issue #1 fix).
 * 2. Score remaining releases.
 * 3. Dedup by master_id (Issue #3 fix), unless this is a temporal query.
 * 4. Sort (Issue #2 fix: no date_added tiebreaker for general queries).
 */
export function applySearchPipeline(
	items: DiscogsCollectionItem[],
	parsed: ParsedQuery,
): DedupedCollectionItem[] {
	// Temporal queries bypass explicit-term filter, mood scoring, and dedup.
	// They surface every pressing ordered by date_added.
	if (parsed.hasRecent || parsed.hasOld) {
		const scored = items.map((item) => ({ item, moodScore: 0, explicitMatch: true }))
		const deduped = scored.map((s) => ({
			item: {
				...s.item,
				ownedFormats: s.item.basic_information.formats?.map((f) => f.name) ?? [],
				mergedInstanceIds: [s.item.instance_id],
			},
			moodScore: 0,
		}))
		return sortScoredReleases(deduped, parsed)
	}

	// 1. Explicit-term hard filter.
	const filtered =
		parsed.explicitGenreTerms.length === 0
			? items
			: items.filter((item) =>
					parsed.explicitGenreTerms.every((term) => releaseMatchesTerm(item, term)),
				)

	// 2. Score.
	const scored = scoreReleases(filtered, parsed)

	// 3. Dedup.
	const deduped = dedupByMaster(scored)

	// 4. Sort.
	return sortScoredReleases(deduped, parsed)
}
```

- [ ] **Step 2: Run full ranking tests**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/utils/searchRanking.test.ts`
Expected: PASS (all tests in the file — scoring, dedup, sort, pipeline).

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
git add src/utils/searchRanking.ts test/utils/searchRanking.test.ts
git commit -m "feat(search): add sortScoredReleases and applySearchPipeline

- Deterministic sort: moodScore, rating, year, artist+title alpha
- date_added removed from general sort chain (Issue #2 fix)
- Temporal queries bypass dedup and scoring"
```

---

## Task 10: Wire pipeline into the search_collection tool

**Files:**
- Modify: `src/mcp/tools/authenticated.ts`

- [ ] **Step 1: Import the new helpers**

At the top of `src/mcp/tools/authenticated.ts` (with the other imports near the top of the file), add:

```ts
import { parseSearchQuery } from '../../utils/searchQueryParser'
import { applySearchPipeline, type DedupedCollectionItem } from '../../utils/searchRanking'
```

- [ ] **Step 2: Replace the cached-path sort block with the new pipeline**

`filterReleasesInMemory` stays unchanged. The parser runs once at the orchestration level on the ORIGINAL user query (not the mood-expanded variants that get fed to `filterReleasesInMemory` in the loop), so there's no benefit to threading `parsed` through the filter.

Find the sort block in `src/mcp/tools/authenticated.ts:681-693`:

```ts
// Sort combined results by rating and date (unless temporal sorting was applied)
if (hasRecent) {
	allResults.sort((a, b) => new Date(b.date_added).getTime() - new Date(a.date_added).getTime())
} else if (hasOld) {
	allResults.sort((a, b) => new Date(a.date_added).getTime() - new Date(b.date_added).getTime())
} else {
	allResults.sort((a, b) => {
		if (a.rating !== b.rating) {
			return b.rating - a.rating
		}
		return new Date(b.date_added).getTime() - new Date(a.date_added).getTime()
	})
}

// Limit to requested page size
const finalResults = allResults.slice(0, per_page)
```

Replace with:

```ts
// Run the ranking pipeline: explicit-term filter → score → dedup by master → sort.
// Temporal queries bypass dedup and mood scoring.
const parsed = parseSearchQuery(query)
const rankedResults: DedupedCollectionItem[] = applySearchPipeline(allResults, parsed)

// Limit to requested page size
const finalResults = rankedResults.slice(0, per_page)
```

- [ ] **Step 3: Update the render loop to show aggregated formats**

Find the render block a few lines below the above change:

```ts
// Create concise formatted list with genres and styles
const releaseList = finalResults
	.map((release) => {
		const info = release.basic_information
		const artists = info.artists.map((a) => a.name).join(', ')
		const formats = info.formats.map((f) => f.name).join(', ')
		const genres = info.genres?.length ? info.genres.join(', ') : 'Unknown'
		const styles = info.styles?.length ? ` | Styles: ${info.styles.join(', ')}` : ''
		const rating = release.rating > 0 ? ` ⭐${release.rating}` : ''

		return `• [ID: ${release.id}] [Instance: ${release.instance_id}] ${artists} - ${info.title} (${info.year})\n  Format: ${formats} | Genre: ${genres}${styles}${rating}`
	})
	.join('\n\n')
```

Replace the `formats` line to use `ownedFormats` when present, falling back to the per-release formats:

```ts
// Create concise formatted list with genres and styles
const releaseList = finalResults
	.map((release) => {
		const info = release.basic_information
		const artists = info.artists.map((a) => a.name).join(', ')
		const formats =
			release.ownedFormats && release.ownedFormats.length > 0
				? release.ownedFormats.join(', ')
				: info.formats.map((f) => f.name).join(', ')
		const genres = info.genres?.length ? info.genres.join(', ') : 'Unknown'
		const styles = info.styles?.length ? ` | Styles: ${info.styles.join(', ')}` : ''
		const rating = release.rating > 0 ? ` ⭐${release.rating}` : ''

		return `• [ID: ${release.id}] [Instance: ${release.instance_id}] ${artists} - ${info.title} (${info.year})\n  Format: ${formats} | Genre: ${genres}${styles}${rating}`
	})
	.join('\n\n')
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run`
Expected: all tests pass. Some `discogs.test.ts` tests may still pass because the dead code path isn't deleted yet (that's Task 12).

- [ ] **Step 6: Commit**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
git add src/mcp/tools/authenticated.ts
git commit -m "feat(search): wire ranking pipeline into search_collection tool

- Replaces rating+date_added sort with applySearchPipeline
- Render line uses ownedFormats when dedup collapsed multiple pressings
- Fixes Issues #1 (explicit-term filter), #2 (no recency bias), #3 (dedup)"
```

---

## Task 11: End-to-end regression tests for the three reported bugs

**Files:**
- Create: `test/mcp/tools/searchCollectionRanking.test.ts`

- [ ] **Step 1: Write the E2E regression test file**

The pipeline itself is already unit-tested in Task 8. This file adds a thin layer of integration tests that assert the three literal scenarios from issue #14 behave correctly when the full pipeline runs.

Create `test/mcp/tools/searchCollectionRanking.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applySearchPipeline } from '../../../src/utils/searchRanking'
import { parseSearchQuery } from '../../../src/utils/searchQueryParser'
import type { DiscogsCollectionItem } from '../../../src/clients/discogs'

/**
 * Regression tests for https://github.com/rianvdm/discogs-mcp/issues/14
 *
 * These tests encode the three scenarios exactly as reported:
 *   1. Query "mellow jazz for late evening" should NOT return zero-jazz results.
 *   2. A broadly-tagged recent alt-rock record should not surface in top 8
 *      for BOTH "rainy Sunday afternoon" and "mellow jazz for late evening".
 *   3. Multiple pressings (Vinyl + CD) of the same master collapse to one row.
 */

function item(args: {
	id: number
	title: string
	artist: string
	year: number
	genres: string[]
	styles: string[]
	formats?: string[]
	master_id?: number
	date_added?: string
}): DiscogsCollectionItem {
	return {
		id: args.id,
		instance_id: args.id * 1000,
		date_added: args.date_added ?? '2020-01-01T00:00:00-00:00',
		rating: 0,
		basic_information: {
			id: args.id,
			master_id: args.master_id,
			title: args.title,
			year: args.year,
			resource_url: '',
			thumb: '',
			cover_image: '',
			formats: (args.formats ?? ['Vinyl']).map((name) => ({ name, qty: '1' })),
			labels: [],
			artists: [{ name: args.artist, id: 1 }],
			genres: args.genres,
			styles: args.styles,
		},
	}
}

// Rian's actual top-8 from the issue report, plus a real jazz record for contrast.
const issue14Fixture: DiscogsCollectionItem[] = [
	item({ id: 1, title: 'Beat', artist: 'Bowery Electric', year: 1996, genres: ['Electronic'], styles: ['Trip Hop', 'Shoegaze', 'Ambient'] }),
	item({
		id: 2,
		title: 'The Tired Sounds Of',
		artist: 'Stars Of The Lid',
		year: 2001,
		genres: ['Electronic'],
		styles: ['Drone', 'Ambient'],
	}),
	item({
		id: 3,
		title: 'The Disintegration Loops',
		artist: 'William Basinski',
		year: 2002,
		genres: ['Electronic'],
		styles: ['Ambient', 'Modern Classical', 'Minimal'],
	}),
	item({
		id: 4,
		title: 'A Fragile Geography - Reworks',
		artist: 'Rafael Anton Irisarri',
		year: 2018,
		genres: ['Electronic'],
		styles: ['Ambient', 'Drone'],
	}),
	item({
		id: 5,
		title: 'Forever Phase',
		artist: 'Paul Meany',
		year: 2025,
		master_id: 5000,
		date_added: '2026-03-15T00:00:00-00:00',
		genres: ['Rock'],
		styles: ['Alternative Rock', 'Indie Rock', 'Dream Pop', 'Shoegaze', 'Lo-Fi'],
		formats: ['Vinyl'],
	}),
	item({
		id: 6,
		title: 'Forever Phase',
		artist: 'Paul Meany',
		year: 2025,
		master_id: 5000,
		date_added: '2026-03-15T00:00:00-00:00',
		genres: ['Rock'],
		styles: ['Alternative Rock', 'Indie Rock', 'Dream Pop', 'Shoegaze', 'Lo-Fi'],
		formats: ['CD'],
	}),
	item({
		id: 7,
		title: 'The Universe Smiles Upon You II',
		artist: 'Khruangbin',
		year: 2015,
		master_id: 7000,
		genres: ['Jazz', 'Funk'],
		styles: ['Psychedelic'],
		formats: ['Vinyl'],
	}),
	item({
		id: 8,
		title: 'The Universe Smiles Upon You II',
		artist: 'Khruangbin',
		year: 2018,
		master_id: 7000,
		genres: ['Jazz', 'Funk'],
		styles: ['Psychedelic'],
		formats: ['CD'],
	}),
	item({
		id: 9,
		title: 'Kind of Blue',
		artist: 'Miles Davis',
		year: 1959,
		genres: ['Jazz'],
		styles: ['Modal'],
	}),
	item({
		id: 10,
		title: 'A Love Supreme',
		artist: 'John Coltrane',
		year: 1965,
		genres: ['Jazz'],
		styles: ['Hard Bop', 'Modal'],
	}),
]

describe('Issue #14 regression', () => {
	it('"mellow jazz for late evening" returns only jazz-tagged results', () => {
		const parsed = parseSearchQuery('mellow jazz for late evening')
		const result = applySearchPipeline(issue14Fixture, parsed)
		// Every result should have "jazz" in genres or styles.
		for (const r of result) {
			const text = [...r.basic_information.genres, ...r.basic_information.styles]
				.join(' ')
				.toLowerCase()
			expect(text).toContain('jazz')
		}
		// At least the two jazz records should be present.
		expect(result.length).toBeGreaterThanOrEqual(2)
	})

	it('Paul Meany does not appear in top results for "mellow jazz for late evening"', () => {
		const parsed = parseSearchQuery('mellow jazz for late evening')
		const result = applySearchPipeline(issue14Fixture, parsed)
		const meanyPresent = result.some((r) => r.basic_information.artists[0].name === 'Paul Meany')
		expect(meanyPresent).toBe(false)
	})

	it('Khruangbin vinyl + CD collapse to a single row with both formats', () => {
		const parsed = parseSearchQuery('mellow jazz for late evening')
		const result = applySearchPipeline(issue14Fixture, parsed)
		const khruangbinRows = result.filter((r) => r.basic_information.artists[0].name === 'Khruangbin')
		expect(khruangbinRows).toHaveLength(1)
		expect(khruangbinRows[0].ownedFormats).toEqual(expect.arrayContaining(['Vinyl', 'CD']))
	})

	it('"something for a rainy Sunday afternoon" does not put Paul Meany above focused mood matches', () => {
		const parsed = parseSearchQuery('something for a rainy Sunday afternoon')
		const result = applySearchPipeline(issue14Fixture, parsed)
		// Paul Meany has 1 mood-match out of 6 tags (Dream Pop); score ≈ 0.17.
		// Miles Davis has 0 mood-match for melancholy but Coltrane has none either.
		// What we assert: the broadly-tagged Paul Meany is not the #1 result.
		if (result.length > 0) {
			expect(result[0].basic_information.artists[0].name).not.toBe('Paul Meany')
		}
	})
})
```

- [ ] **Step 2: Run the regression tests**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run test/mcp/tools/searchCollectionRanking.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
git add test/mcp/tools/searchCollectionRanking.test.ts
git commit -m "test(search): add Issue #14 regression tests for ranking bugs"
```

---

## Task 12: Delete dead scoring code in discogs.ts

**Files:**
- Modify: `src/clients/discogs.ts`

- [ ] **Step 1: Open the file and locate the dead block**

Read `src/clients/discogs.ts` lines 520-670 to confirm the block boundaries. The dead code is the `if (filteredQuery.trim() && filteredQuery.includes(' ') && !hasRecent && !hasOld)` block starting around line 524 through line 656 (ending with `filteredReleases = releasesWithRelevance.map(...)`).

- [ ] **Step 2: Replace the dead scoring block with the default sort**

Replace the entire block from:

```ts
// Apply relevance scoring for multi-word queries to prioritize better matches
if (filteredQuery.trim() && filteredQuery.includes(' ') && !hasRecent && !hasOld) {
```

through the closing brace of:

```ts
} else {
	// Fall back to default sorting (by rating and date)
	filteredReleases.sort((a: DiscogsCollectionItem, b: DiscogsCollectionItem) => {
		if (a.rating !== b.rating) {
			return b.rating - a.rating
		}
		return new Date(b.date_added).getTime() - new Date(a.date_added).getTime()
	})
}
```

with just:

```ts
// Default sorting: rating desc, then date added desc.
// Note: the cached path in search_collection runs its own ranking pipeline
// via applySearchPipeline and does NOT hit this sort. This branch only
// matters for the fallback non-cached path (rare in practice).
if (!hasRecent && !hasOld) {
	filteredReleases.sort((a: DiscogsCollectionItem, b: DiscogsCollectionItem) => {
		if (a.rating !== b.rating) {
			return b.rating - a.rating
		}
		return new Date(b.date_added).getTime() - new Date(a.date_added).getTime()
	})
}
```

- [ ] **Step 3: Remove now-unused imports if any**

Check the top of `src/clients/discogs.ts` for the line:

```ts
import { hasMoodContent, analyzeMoodQuery } from '../utils/moodMapping'
```

After deleting the scoring block, grep the rest of the file to check if `hasMoodContent` or `analyzeMoodQuery` are still used:

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && grep -nE "hasMoodContent|analyzeMoodQuery" src/clients/discogs.ts`

If neither name appears anywhere else in the file, delete the import line. Otherwise leave it.

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run`
Expected: all tests pass. Existing `test/clients/discogs.test.ts` may have tests that exercised the dead block — if any fail, read the failing test and decide: (a) if the test asserts behavior of the removed scoring code specifically, delete the test with a one-line note in the commit message; (b) if the test asserts general filter behavior, investigate whether the change broke filtering.

- [ ] **Step 6: Commit**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
git add src/clients/discogs.ts
git commit -m "refactor(search): delete dead scoring code in DiscogsClient.searchCollectionWithQuery

The cached path in search_collection always runs applySearchPipeline
now, making this branch unreachable in production. Kept the simple
rating+date_added fallback sort for the rare non-cached path."
```

---

## Task 13: Final verification

**Files:** None — run-only task.

- [ ] **Step 1: Full test suite**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm test -- --run`
Expected: all tests pass.

- [ ] **Step 2: Typecheck**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Lint**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm run lint`
Expected: clean.

- [ ] **Step 4: Build (dry-run wrangler deploy)**

Run: `cd /Users/rian/Documents/GitHub/discogs-mcp && npm run build`
Expected: clean build, `dist/` produced.

- [ ] **Step 5: Report to user**

Report completion to the user with:

- Summary of commits made (`git log --oneline main..HEAD`)
- Confirmation that the three Issue #14 scenarios pass in the regression test file
- Hand off for local testing — per the corrections rule, do NOT push or create an MR until the user has tested locally and approved
