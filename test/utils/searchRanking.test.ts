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
