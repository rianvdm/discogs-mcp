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

function artistTitleKey(item: DedupedCollectionItem): string {
	const info = item.basic_information
	const artist = (info.artists?.[0]?.name ?? '').toLowerCase()
	const title = (info.title ?? '').toLowerCase()
	return `${artist} - ${title}`
}

export type SortMode = 'relevance' | 'recent' | 'oldest' | 'year_desc' | 'year_asc' | 'rating'

const dateAdded = (item: DedupedCollectionItem): number => new Date(item.date_added).getTime()
const yearOrMax = (item: DedupedCollectionItem): number =>
	item.basic_information.year ?? Number.MAX_SAFE_INTEGER
const yearOrZero = (item: DedupedCollectionItem): number => item.basic_information.year ?? 0

/**
 * Final-tiebreaker for any sort: artist+title alpha → id asc.
 */
function finalTiebreak(a: ScoredDedupedRelease, b: ScoredDedupedRelease): number {
	const keyA = artistTitleKey(a.item)
	const keyB = artistTitleKey(b.item)
	if (keyA !== keyB) return keyA.localeCompare(keyB)
	return a.item.id - b.item.id
}

/**
 * Sort releases according to the requested mode.
 *
 * `relevance` (default) preserves the existing query-aware ranking:
 *   - For mood queries: moodScore desc → rating desc → year asc → tiebreak.
 *   - For non-mood queries: rating desc → date_added desc → year desc → tiebreak.
 *     This surfaces rated favorites and recent acquisitions on broad inventory
 *     queries instead of burying them under year-asc tiebreaking (issue #21).
 *   - For query-level temporal terms (`hasRecent`/`hasOld`), date_added wins.
 *
 * Explicit sort modes (`recent`, `oldest`, `year_desc`, `year_asc`, `rating`)
 * win over query-level temporal terms — if the caller passed a sort, they
 * meant it.
 */
export function sortScoredReleases(
	deduped: ScoredDedupedRelease[],
	parsed: ParsedQuery,
	sort: SortMode = 'relevance',
): DedupedCollectionItem[] {
	const copy = [...deduped]

	if (sort !== 'relevance') {
		copy.sort((a, b) => {
			let primary = 0
			switch (sort) {
				case 'recent':
					primary = dateAdded(b.item) - dateAdded(a.item)
					break
				case 'oldest':
					primary = dateAdded(a.item) - dateAdded(b.item)
					break
				case 'year_desc':
					primary = yearOrZero(b.item) - yearOrZero(a.item)
					break
				case 'year_asc':
					primary = yearOrMax(a.item) - yearOrMax(b.item)
					break
				case 'rating':
					primary = b.item.rating - a.item.rating
					if (primary === 0) primary = dateAdded(b.item) - dateAdded(a.item)
					break
			}
			if (primary !== 0) return primary
			return finalTiebreak(a, b)
		})
		return copy.map((s) => s.item)
	}

	if (parsed.hasRecent) {
		copy.sort((a, b) => dateAdded(b.item) - dateAdded(a.item))
		return copy.map((s) => s.item)
	}
	if (parsed.hasOld) {
		copy.sort((a, b) => dateAdded(a.item) - dateAdded(b.item))
		return copy.map((s) => s.item)
	}

	copy.sort((a, b) => {
		if (b.moodScore !== a.moodScore) return b.moodScore - a.moodScore
		if (b.item.rating !== a.item.rating) return b.item.rating - a.item.rating

		if (parsed.isMoodQuery) {
			const yearDelta = yearOrMax(a.item) - yearOrMax(b.item)
			if (yearDelta !== 0) return yearDelta
		} else {
			const dateDelta = dateAdded(b.item) - dateAdded(a.item)
			if (dateDelta !== 0) return dateDelta
			const yearDelta = yearOrZero(b.item) - yearOrZero(a.item)
			if (yearDelta !== 0) return yearDelta
		}

		return finalTiebreak(a, b)
	})
	return copy.map((s) => s.item)
}

export interface SearchPipelineOptions {
	/** Sort mode applied to the ranked results. Defaults to 'relevance'. */
	sort?: SortMode
}

/**
 * End-to-end ranking pipeline.
 *
 * 1. Apply explicit-term hard filter (Issue #1 fix).
 * 2. Score remaining releases.
 * 3. Dedup by master_id (Issue #3 fix), unless this is a query-level temporal
 *    request under default `relevance` sort.
 * 4. Sort according to options.sort (Issue #2 + #21).
 */
export function applySearchPipeline(
	items: DiscogsCollectionItem[],
	parsed: ParsedQuery,
	options: SearchPipelineOptions = {},
): DedupedCollectionItem[] {
	const sort = options.sort ?? 'relevance'

	// Query-level temporal terms only bypass scoring/dedup under default sort.
	// An explicit sort override means the caller wants the full pipeline applied
	// before sorting.
	if (sort === 'relevance' && (parsed.hasRecent || parsed.hasOld)) {
		const deduped: ScoredDedupedRelease[] = items.map((item) => ({
			item: {
				...item,
				ownedFormats: item.basic_information.formats?.map((f) => f.name) ?? [],
				mergedInstanceIds: [item.instance_id],
			},
			moodScore: 0,
		}))
		return sortScoredReleases(deduped, parsed, sort)
	}

	const filtered =
		parsed.explicitGenreTerms.length === 0
			? items
			: items.filter((item) =>
					parsed.explicitGenreTerms.every((term) => releaseMatchesTerm(item, term)),
				)

	const scored = scoreReleases(filtered, parsed)
	const deduped = dedupByMaster(scored)
	return sortScoredReleases(deduped, parsed, sort)
}
