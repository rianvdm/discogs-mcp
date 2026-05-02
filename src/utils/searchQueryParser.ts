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

/**
 * Minimal shape needed to disambiguate temporal tokens against the user's
 * collection. Defined structurally so this module doesn't depend on the
 * full DiscogsCollectionItem.
 */
export interface TemporalDisambiguationItem {
	basic_information: {
		title?: string
		artists?: { name: string }[]
	}
}

/**
 * Clear `hasRecent` / `hasOld` on a parsed query when the trigger token also
 * appears as a literal word in some release's title or artist field.
 *
 * Background: temporal sort fires on words like "new", "old", "latest". For
 * a query like "Lee Morgan Search For The New Land", the word "New" is part
 * of the album title — the user wants the literal record, not "items added
 * recently." Without this disambiguation, the temporal sort wins and the
 * literal match gets buried.
 *
 * Heuristic: if the temporal trigger token appears anywhere in the
 * collection's title/artist text as a whole word, treat the query as
 * literal. Bare temporal queries like "recent" still work because "recent"
 * doesn't typically appear in titles.
 */
export function clearTemporalIfTokenIsLiteral(
	query: string,
	parsed: ParsedQuery,
	releases: TemporalDisambiguationItem[],
): ParsedQuery {
	if (!parsed.hasRecent && !parsed.hasOld) return parsed

	const queryWords = new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 0))
	const recentTriggers = [...RECENT_TERMS].filter((t) => queryWords.has(t))
	const oldTriggers = [...OLD_TERMS].filter((t) => queryWords.has(t))

	const collectionWords = new Set<string>()
	for (const item of releases) {
		const info = item.basic_information
		const text = [info.title ?? '', ...(info.artists ?? []).map((a) => a.name)]
			.join(' ')
			.toLowerCase()
		for (const word of text.split(/\s+/)) {
			if (word) collectionWords.add(word)
		}
	}

	const recentIsLiteral = recentTriggers.some((t) => collectionWords.has(t))
	const oldIsLiteral = oldTriggers.some((t) => collectionWords.has(t))

	if (!recentIsLiteral && !oldIsLiteral) return parsed

	return {
		...parsed,
		hasRecent: parsed.hasRecent && !recentIsLiteral,
		hasOld: parsed.hasOld && !oldIsLiteral,
	}
}
