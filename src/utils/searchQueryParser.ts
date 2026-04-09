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
