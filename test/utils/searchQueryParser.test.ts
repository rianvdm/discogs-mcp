import { describe, it, expect } from 'vitest'
import { clearTemporalIfTokenIsLiteral, parseSearchQuery } from '../../src/utils/searchQueryParser'

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

describe('clearTemporalIfTokenIsLiteral', () => {
	const release = (title: string, artist: string) => ({
		basic_information: { title, artists: [{ name: artist }] },
	})

	it('clears hasRecent when "new" appears literally in a collection title', () => {
		const releases = [
			release('Search For The New Land', 'Lee Morgan'),
			release('Kind of Blue', 'Miles Davis'),
		]
		const parsed = parseSearchQuery('Lee Morgan Search For The New Land')
		expect(parsed.hasRecent).toBe(true)
		const disambiguated = clearTemporalIfTokenIsLiteral(
			'Lee Morgan Search For The New Land',
			parsed,
			releases,
		)
		expect(disambiguated.hasRecent).toBe(false)
	})

	it('clears hasRecent when "new" appears in an artist name', () => {
		const releases = [release('Sigh No More', 'Mumford & Sons'), release('New Beginning', 'Tracy Chapman')]
		const parsed = parseSearchQuery('tracy chapman new beginning')
		expect(parsed.hasRecent).toBe(true)
		const disambiguated = clearTemporalIfTokenIsLiteral('tracy chapman new beginning', parsed, releases)
		expect(disambiguated.hasRecent).toBe(false)
	})

	it('preserves hasRecent for bare temporal queries when token is not in collection', () => {
		const releases = [release('Kind of Blue', 'Miles Davis'), release('Folk Singer', 'Muddy Waters')]
		const parsed = parseSearchQuery('recent')
		expect(parsed.hasRecent).toBe(true)
		const disambiguated = clearTemporalIfTokenIsLiteral('recent', parsed, releases)
		expect(disambiguated.hasRecent).toBe(true)
	})

	it('preserves hasRecent for compound queries when token is not in collection', () => {
		const releases = [release('Kind of Blue', 'Miles Davis')]
		const parsed = parseSearchQuery('recent jazz')
		expect(parsed.hasRecent).toBe(true)
		const disambiguated = clearTemporalIfTokenIsLiteral('recent jazz', parsed, releases)
		expect(disambiguated.hasRecent).toBe(true)
	})

	it('clears hasOld for old/oldest when token appears literally', () => {
		const releases = [release('Old Crow Medicine Show', 'Old Crow')]
		const parsed = parseSearchQuery('old crow')
		expect(parsed.hasOld).toBe(true)
		const disambiguated = clearTemporalIfTokenIsLiteral('old crow', parsed, releases)
		expect(disambiguated.hasOld).toBe(false)
	})

	it('returns original parsed object unchanged when no temporal flags are set', () => {
		const releases = [release('Kind of Blue', 'Miles Davis')]
		const parsed = parseSearchQuery('miles davis')
		const disambiguated = clearTemporalIfTokenIsLiteral('miles davis', parsed, releases)
		expect(disambiguated).toBe(parsed)
	})
})
