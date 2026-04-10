import { describe, it, expect } from 'vitest'
import { filterReleasesInMemory } from '../../../src/mcp/tools/authenticated'
import type { DiscogsCollectionItem } from '../../../src/clients/discogs'

/**
 * Regression tests for https://github.com/rianvdm/discogs-mcp/issues/17
 *
 * "Stretch Music" query was returning 7 false positives because the word
 * "music" substring-matched the genre "Non-Music", flipping the filter
 * to OR mode for those releases.
 */

function item(args: {
	id: number
	title: string
	artist: string
	year: number
	genres: string[]
	styles: string[]
}): DiscogsCollectionItem {
	return {
		id: args.id,
		instance_id: args.id * 1000,
		date_added: '2020-01-01T00:00:00-00:00',
		rating: 0,
		basic_information: {
			id: args.id,
			master_id: args.id,
			title: args.title,
			year: args.year,
			resource_url: '',
			thumb: '',
			cover_image: '',
			formats: [{ name: 'Vinyl', qty: '1' }],
			labels: [],
			artists: [{ name: args.artist, id: 1 }],
			genres: args.genres,
			styles: args.styles,
		},
	}
}

const issue17Fixture: DiscogsCollectionItem[] = [
	item({ id: 1, title: 'Stretch Music', artist: 'Christian Scott aTunde Adjuah', year: 2015, genres: ['Jazz'], styles: ['Contemporary Jazz'] }),
	item({ id: 2, title: 'The Blue Notebooks', artist: 'Max Richter', year: 2004, genres: ['Classical', 'Non-Music'], styles: ['Contemporary', 'Modern Classical', 'Spoken Word'] }),
	item({ id: 3, title: 'Glo', artist: 'Delirious?', year: 2000, genres: ['Rock', 'Non-Music'], styles: ['Alternative Rock', 'Religious'] }),
	item({ id: 4, title: '1983-1998', artist: 'Genesis', year: 2004, genres: ['Rock', 'Pop', 'Non-Music'], styles: ['Pop Rock', 'Prog Rock'] }),
	item({ id: 5, title: 'Empty', artist: 'Nils Frahm', year: 2020, genres: ['Electronic', 'Non-Music'], styles: ['Ambient', 'Modern Classical'] }),
	item({ id: 6, title: 'Kind of Blue', artist: 'Miles Davis', year: 1959, genres: ['Jazz'], styles: ['Modal'] }),
]

describe('Issue #17 regression', () => {
	it('"Stretch Music" only returns the matching album, not Non-Music false positives', () => {
		const result = filterReleasesInMemory(issue17Fixture, 'Stretch Music')
		const titles = result.map((r) => r.basic_information.title)
		expect(titles).toContain('Stretch Music')
		expect(titles).not.toContain('The Blue Notebooks')
		expect(titles).not.toContain('Glo')
		expect(titles).not.toContain('1983-1998')
		expect(titles).not.toContain('Empty')
	})

	it('"Stretch Music" returns exactly 1 result', () => {
		const result = filterReleasesInMemory(issue17Fixture, 'Stretch Music')
		expect(result).toHaveLength(1)
		expect(result[0].basic_information.artists[0].name).toBe('Christian Scott aTunde Adjuah')
	})

	it('queries with real genre names still use OR logic correctly', () => {
		const result = filterReleasesInMemory(issue17Fixture, 'jazz modal')
		expect(result.length).toBeGreaterThanOrEqual(1)
		const titles = result.map((r) => r.basic_information.title)
		expect(titles).toContain('Kind of Blue')
	})
})
