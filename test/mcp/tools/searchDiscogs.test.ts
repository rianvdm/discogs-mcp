import { describe, it, expect } from 'vitest'
import { formatSearchDiscogsResults } from '../../../src/utils/searchDiscogsFormatter'
import type { DiscogsSearchResponse } from '../../../src/clients/discogs'

function fakeSearchResult(overrides: Partial<DiscogsSearchResponse['results'][number]> & { id: number; title: string }): DiscogsSearchResponse['results'][number] {
	return {
		id: overrides.id,
		type: 'master',
		title: overrides.title,
		year: 2000,
		format: ['Vinyl'],
		label: ['Some Label'],
		genre: ['Rock'],
		style: ['Alt Rock'],
		country: 'US',
		thumb: '',
		cover_image: '',
		resource_url: '',
		master_id: overrides.master_id,
		...overrides,
	}
}

function fakeResponse(results: DiscogsSearchResponse['results']): DiscogsSearchResponse {
	return {
		pagination: {
			pages: 1,
			page: 1,
			per_page: 10,
			items: results.length,
			urls: {},
		},
		results,
	}
}

describe('formatSearchDiscogsResults', () => {
	it('marks results already in the collection with a checkmark', () => {
		const response = fakeResponse([
			fakeSearchResult({ id: 100, title: 'Owned Album', master_id: 100 }),
			fakeSearchResult({ id: 200, title: 'Not Owned Album', master_id: 200 }),
			fakeSearchResult({ id: 300, title: 'Also Not Owned', master_id: 300 }),
		])
		const ownedMasterIds = new Set([100])
		const ownedReleaseIds = new Set<number>()
		const output = formatSearchDiscogsResults(response, ownedMasterIds, ownedReleaseIds, 'test', 'master')
		expect(output).toContain('Owned Album')
		expect(output).toContain('Not Owned Album')
		expect(output).toContain('Also Not Owned')
		// Owned line has the marker
		const ownedLine = output.split('\n').find((l) => l.includes('Owned Album') && !l.includes('Not Owned'))!
		expect(ownedLine).toContain('✓ in your collection')
		// Not-owned lines do NOT have the marker
		const notOwnedLines = output.split('\n').filter((l) => l.includes('Not Owned'))
		for (const line of notOwnedLines) {
			expect(line).not.toContain('✓ in your collection')
		}
	})

	it('uses release.id fallback when type is release and master_id is absent', () => {
		const response = fakeResponse([
			{ ...fakeSearchResult({ id: 500, title: 'Release Match', master_id: undefined }), type: 'release' },
			{ ...fakeSearchResult({ id: 600, title: 'Release No Match', master_id: undefined }), type: 'release' },
		])
		const ownedMasterIds = new Set<number>()
		const ownedReleaseIds = new Set([500])
		const output = formatSearchDiscogsResults(response, ownedMasterIds, ownedReleaseIds, 'test', 'release')
		const matchLine = output.split('\n').find((l) => l.includes('Release Match'))!
		expect(matchLine).toContain('✓ in your collection')
		const noMatchLine = output.split('\n').find((l) => l.includes('Release No Match'))!
		expect(noMatchLine).not.toContain('✓ in your collection')
	})

	it('includes result count and query in the header', () => {
		const response = fakeResponse([fakeSearchResult({ id: 1, title: 'Album' })])
		const output = formatSearchDiscogsResults(response, new Set(), new Set(), 'miles davis', 'master')
		expect(output).toContain('Found 1')
		expect(output).toContain('miles davis')
		expect(output).toContain('type: master')
	})

	it('renders artist and label results with just ID and title', () => {
		const response = fakeResponse([{ ...fakeSearchResult({ id: 700, title: 'Kind of Blue Records' }), type: 'label' }])
		const output = formatSearchDiscogsResults(response, new Set(), new Set(), 'blue', 'label')
		expect(output).toContain('[ID: 700]')
		expect(output).toContain('Kind of Blue Records')
	})

	it('returns a "no results" message when the response is empty', () => {
		const response = fakeResponse([])
		const output = formatSearchDiscogsResults(response, new Set(), new Set(), 'nothing', 'master')
		expect(output.toLowerCase()).toContain('no results')
	})
})
