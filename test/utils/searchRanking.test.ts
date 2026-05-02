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
		expect(rep.moodScore).toBeGreaterThan(0)
	})

	it('falls back to artist+title+year when master_id is missing', () => {
		const items = [
			release({ id: 20, title: 'Live at X', artist: 'Band', year: 1975, genres: [], styles: [] }),
			release({ id: 21, title: 'Live at X', artist: 'Band', year: 2020, genres: [], styles: [] }),
		]
		const scored = scoreReleases(items, parseSearchQuery('anything'))
		const deduped = dedupByMaster(scored)
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

	it('non-mood queries tiebreak by rating desc, then date_added desc, then year desc, then artist+title alpha', () => {
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
		// id 3 wins on rating. Among rating=3 items, all share date_added,
		// so year desc breaks: id 1 (2005) > id 2,4 (2000). Among year=2000,
		// title alpha: A (id 2) < K (id 4).
		expect(sorted[0].id).toBe(3)
		expect(sorted[1].id).toBe(1)
		expect(sorted[2].id).toBe(2)
		expect(sorted[3].id).toBe(4)
	})

	it('non-mood queries use date_added desc as a tiebreaker (issue #21)', () => {
		const items = [
			release({ id: 1, title: 'A', artist: 'A', year: 2000, rating: 0, date_added: '2020-01-01T00:00:00-00:00', genres: [], styles: [] }),
			release({ id: 2, title: 'A', artist: 'A', year: 2000, rating: 0, date_added: '2026-01-01T00:00:00-00:00', master_id: 500, genres: [], styles: [] }),
		]
		const parsed = parseSearchQuery('anything')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed)
		// More recently added wins under non-mood relevance sort.
		expect(sorted[0].id).toBe(2)
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

	it('explicit sort=recent overrides relevance behavior', () => {
		const items = [
			release({ id: 1, title: 'A', artist: 'A', year: 1965, rating: 5, date_added: '2010-01-01T00:00:00-00:00', genres: [], styles: [] }),
			release({ id: 2, title: 'B', artist: 'B', year: 2024, rating: 0, date_added: '2026-01-01T00:00:00-00:00', genres: [], styles: [] }),
		]
		const parsed = parseSearchQuery('jazz')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed, 'recent')
		// id 2 has more recent date_added, even though id 1 has higher rating.
		expect(sorted[0].id).toBe(2)
	})

	it('explicit sort=rating ranks by user rating', () => {
		const items = [
			release({ id: 1, title: 'A', artist: 'A', year: 2020, rating: 2, genres: [], styles: [] }),
			release({ id: 2, title: 'B', artist: 'B', year: 1965, rating: 5, genres: [], styles: [] }),
			release({ id: 3, title: 'C', artist: 'C', year: 2024, rating: 4, genres: [], styles: [] }),
		]
		const parsed = parseSearchQuery('anything')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed, 'rating')
		expect(sorted.map((s) => s.id)).toEqual([2, 3, 1])
	})

	it('explicit sort=year_desc surfaces newest pressings first', () => {
		const items = [
			release({ id: 1, title: 'A', artist: 'A', year: 1965, genres: [], styles: [] }),
			release({ id: 2, title: 'B', artist: 'B', year: 2021, genres: [], styles: [] }),
			release({ id: 3, title: 'C', artist: 'C', year: 1990, genres: [], styles: [] }),
		]
		const parsed = parseSearchQuery('anything')
		const scored = scoreReleases(items, parsed)
		const deduped = dedupByMaster(scored)
		const sorted = sortScoredReleases(deduped, parsed, 'year_desc')
		expect(sorted.map((s) => s.id)).toEqual([2, 3, 1])
	})

	it('issue #21: non-mood query default surfaces recent acquisition over older pressing', () => {
		// Reproduces the AP 2021 Folk Singer scenario: rating=0 across the
		// board, all from same artist. Under the old year-asc tiebreaker the
		// 1964 pressing buries the 2021 reissue. Under the new default it
		// surfaces by date_added desc.
		const items = [
			release({ id: 1, title: 'Folk Singer', artist: 'Muddy Waters', year: 1964, rating: 0, date_added: '2018-01-01T00:00:00-00:00', genres: ['Blues'], styles: [] }),
			release({ id: 2, title: 'Folk Singer', artist: 'Muddy Waters', year: 1964, rating: 0, date_added: '2026-04-01T00:00:00-00:00', genres: ['Blues'], styles: [] }),
		]
		const parsed = parseSearchQuery('muddy waters')
		const scored = scoreReleases(items, parsed)
		const sorted = sortScoredReleases(scored.map((s) => ({
			item: { ...s.item, ownedFormats: [], mergedInstanceIds: [s.item.instance_id] },
			moodScore: s.moodScore,
		})), parsed)
		expect(sorted[0].id).toBe(2)
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
		expect(result).toHaveLength(2)
		expect(result[0].id).toBe(11)
	})
})
