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
