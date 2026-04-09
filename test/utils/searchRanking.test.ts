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
