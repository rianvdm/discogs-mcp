/**
 * Full-text relevance ranking for search_collection.
 *
 * Wraps MiniSearch (BM25-style scoring with field boosting) so the rest of the
 * pipeline can ask "score these candidates against the query" without depending
 * on the search-library API directly.
 *
 * Pure functions only. No I/O, no network.
 */

import MiniSearch from 'minisearch'
import type { DiscogsCollectionItem } from '../clients/discogs'

/**
 * Index document. One per (release_id, instance_id) pair so multiple owned
 * pressings of the same master are scored independently.
 */
export interface IndexableRelease {
	id: string
	release_id: number
	instance_id: number
	title: string
	artist: string
	genres: string
	styles: string
	formats: string
}

const SEARCH_FIELDS = ['title', 'artist', 'genres', 'styles', 'formats'] as const
const FIELD_BOOSTS: Record<string, number> = {
	// Artist outweighs title intentionally: a query like "best of genesis"
	// should rank Genesis-the-artist above an Ornette Coleman record titled
	// "Genesis of Genius". Without the boost, title 3× beats artist 2× and
	// the wrong record surfaces.
	artist: 5,
	title: 3,
	styles: 1,
	genres: 1,
	formats: 1,
}

/**
 * Conservative stop-word list. Common English function words that add noise
 * to multi-token queries without contributing real signal — e.g. without
 * filtering, "Best Of Genesis" matches "Of" in many album titles and pushes
 * unrelated compilations above actual Genesis releases.
 *
 * Applied to BOTH indexing and querying so the index doesn't store these
 * tokens and the query doesn't search for them.
 */
const STOP_WORDS = new Set([
	'a',
	'an',
	'and',
	'at',
	'by',
	'for',
	'from',
	'in',
	'of',
	'on',
	'or',
	'the',
	'to',
	'with',
])

function processTerm(term: string): string | null {
	const lower = term.toLowerCase()
	return STOP_WORDS.has(lower) ? null : lower
}

export function indexableId(item: DiscogsCollectionItem): string {
	return `${item.id}:${item.instance_id}`
}

export function toIndexable(item: DiscogsCollectionItem): IndexableRelease {
	const info = item.basic_information
	return {
		id: indexableId(item),
		release_id: item.id,
		instance_id: item.instance_id,
		title: info.title ?? '',
		artist: (info.artists ?? []).map((a) => a.name).join(' '),
		genres: (info.genres ?? []).join(' '),
		styles: (info.styles ?? []).join(' '),
		formats: (info.formats ?? []).map((f) => f.name).join(' '),
	}
}

export function buildIndex(items: DiscogsCollectionItem[]): MiniSearch<IndexableRelease> {
	const index = new MiniSearch<IndexableRelease>({
		fields: [...SEARCH_FIELDS],
		storeFields: ['release_id', 'instance_id'],
		processTerm,
	})
	index.addAll(items.map(toIndexable))
	return index
}

/**
 * Search the index and return a Map of indexable id → relevance score.
 *
 * Scores are MiniSearch's BM25-derived values; only the *relative* magnitudes
 * matter to the caller. Empty queries return an empty Map; the caller should
 * fall back to a non-relevance sort.
 */
export function searchIndex(
	index: MiniSearch<IndexableRelease>,
	query: string,
): Map<string, number> {
	const trimmed = query.trim()
	if (!trimmed) return new Map()
	const results = index.search(trimmed, {
		boost: FIELD_BOOSTS,
		// OR-combine + BM25: documents matching MORE query tokens score higher
		// than documents matching only one. AND-combine was too strict — it
		// rejected reasonable queries like "Best Of Genesis" when no release
		// literally contained the word "best" in any indexed field.
		combineWith: 'OR',
		prefix: true,
		fuzzy: 0.2,
	})
	const scores = new Map<string, number>()
	for (const r of results) {
		scores.set(String(r.id), r.score)
	}
	return scores
}
