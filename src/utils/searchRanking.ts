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
