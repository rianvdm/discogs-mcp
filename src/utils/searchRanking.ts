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
