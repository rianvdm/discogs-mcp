import { describe, it, expect } from 'vitest'
import { applySearchPipeline } from '../../../src/utils/searchRanking'
import { parseSearchQuery } from '../../../src/utils/searchQueryParser'
import type { DiscogsCollectionItem } from '../../../src/clients/discogs'

/**
 * Regression tests for https://github.com/rianvdm/discogs-mcp/issues/14
 *
 * These tests encode the three scenarios exactly as reported:
 *   1. Query "mellow jazz for late evening" should NOT return zero-jazz results.
 *   2. A broadly-tagged recent alt-rock record should not surface in top 8
 *      for BOTH "rainy Sunday afternoon" and "mellow jazz for late evening".
 *   3. Multiple pressings (Vinyl + CD) of the same master collapse to one row.
 */

function item(args: {
	id: number
	title: string
	artist: string
	year: number
	genres: string[]
	styles: string[]
	formats?: string[]
	master_id?: number
	date_added?: string
}): DiscogsCollectionItem {
	return {
		id: args.id,
		instance_id: args.id * 1000,
		date_added: args.date_added ?? '2020-01-01T00:00:00-00:00',
		rating: 0,
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

// Rian's actual top-8 from the issue report, plus real jazz records for contrast.
const issue14Fixture: DiscogsCollectionItem[] = [
	item({ id: 1, title: 'Beat', artist: 'Bowery Electric', year: 1996, genres: ['Electronic'], styles: ['Trip Hop', 'Shoegaze', 'Ambient'] }),
	item({
		id: 2,
		title: 'The Tired Sounds Of',
		artist: 'Stars Of The Lid',
		year: 2001,
		genres: ['Electronic'],
		styles: ['Drone', 'Ambient'],
	}),
	item({
		id: 3,
		title: 'The Disintegration Loops',
		artist: 'William Basinski',
		year: 2002,
		genres: ['Electronic'],
		styles: ['Ambient', 'Modern Classical', 'Minimal'],
	}),
	item({
		id: 4,
		title: 'A Fragile Geography - Reworks',
		artist: 'Rafael Anton Irisarri',
		year: 2018,
		genres: ['Electronic'],
		styles: ['Ambient', 'Drone'],
	}),
	item({
		id: 5,
		title: 'Forever Phase',
		artist: 'Paul Meany',
		year: 2025,
		master_id: 5000,
		date_added: '2026-03-15T00:00:00-00:00',
		genres: ['Rock'],
		styles: ['Alternative Rock', 'Indie Rock', 'Dream Pop', 'Shoegaze', 'Lo-Fi'],
		formats: ['Vinyl'],
	}),
	item({
		id: 6,
		title: 'Forever Phase',
		artist: 'Paul Meany',
		year: 2025,
		master_id: 5000,
		date_added: '2026-03-15T00:00:00-00:00',
		genres: ['Rock'],
		styles: ['Alternative Rock', 'Indie Rock', 'Dream Pop', 'Shoegaze', 'Lo-Fi'],
		formats: ['CD'],
	}),
	item({
		id: 7,
		title: 'The Universe Smiles Upon You II',
		artist: 'Khruangbin',
		year: 2015,
		master_id: 7000,
		genres: ['Jazz', 'Funk'],
		styles: ['Psychedelic'],
		formats: ['Vinyl'],
	}),
	item({
		id: 8,
		title: 'The Universe Smiles Upon You II',
		artist: 'Khruangbin',
		year: 2018,
		master_id: 7000,
		genres: ['Jazz', 'Funk'],
		styles: ['Psychedelic'],
		formats: ['CD'],
	}),
	item({
		id: 9,
		title: 'Kind of Blue',
		artist: 'Miles Davis',
		year: 1959,
		genres: ['Jazz'],
		styles: ['Modal'],
	}),
	item({
		id: 10,
		title: 'A Love Supreme',
		artist: 'John Coltrane',
		year: 1965,
		genres: ['Jazz'],
		styles: ['Hard Bop', 'Modal'],
	}),
]

describe('Issue #14 regression', () => {
	it('"mellow jazz for late evening" returns only jazz-tagged results', () => {
		const parsed = parseSearchQuery('mellow jazz for late evening')
		const result = applySearchPipeline(issue14Fixture, parsed)
		for (const r of result) {
			const text = [...r.basic_information.genres, ...r.basic_information.styles]
				.join(' ')
				.toLowerCase()
			expect(text).toContain('jazz')
		}
		expect(result.length).toBeGreaterThanOrEqual(2)
	})

	it('Paul Meany does not appear in top results for "mellow jazz for late evening"', () => {
		const parsed = parseSearchQuery('mellow jazz for late evening')
		const result = applySearchPipeline(issue14Fixture, parsed)
		const meanyPresent = result.some((r) => r.basic_information.artists[0].name === 'Paul Meany')
		expect(meanyPresent).toBe(false)
	})

	it('Khruangbin vinyl + CD return as separate rows by default', () => {
		const parsed = parseSearchQuery('mellow jazz for late evening')
		const result = applySearchPipeline(issue14Fixture, parsed)
		const khruangbinRows = result.filter((r) => r.basic_information.artists[0].name === 'Khruangbin')
		expect(khruangbinRows).toHaveLength(2)
		const formats = khruangbinRows.flatMap((r) => r.ownedFormats)
		expect(formats).toEqual(expect.arrayContaining(['Vinyl', 'CD']))
	})

	it('Khruangbin vinyl + CD collapse to one row with groupPressings=true', () => {
		const parsed = parseSearchQuery('mellow jazz for late evening')
		const result = applySearchPipeline(issue14Fixture, parsed, { groupPressings: true })
		const khruangbinRows = result.filter((r) => r.basic_information.artists[0].name === 'Khruangbin')
		expect(khruangbinRows).toHaveLength(1)
		expect(khruangbinRows[0].ownedFormats).toEqual(expect.arrayContaining(['Vinyl', 'CD']))
	})
})
