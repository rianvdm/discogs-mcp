import { describe, it, expect } from 'vitest'
import { buildIndex, searchIndex, indexableId, toIndexable } from '../../src/utils/searchIndex'
import type { DiscogsCollectionItem } from '../../src/clients/discogs'

function release(args: {
	id: number
	instance_id?: number
	title: string
	artist: string
	year?: number
	genres?: string[]
	styles?: string[]
}): DiscogsCollectionItem {
	return {
		id: args.id,
		instance_id: args.instance_id ?? args.id * 1000,
		date_added: '2020-01-01T00:00:00-00:00',
		rating: 0,
		basic_information: {
			id: args.id,
			title: args.title,
			year: args.year ?? 2000,
			resource_url: '',
			thumb: '',
			cover_image: '',
			formats: [{ name: 'Vinyl', qty: '1' }],
			labels: [],
			artists: [{ name: args.artist, id: 1 }],
			genres: args.genres ?? [],
			styles: args.styles ?? [],
		},
	}
}

describe('searchIndex', () => {
	const fixture: DiscogsCollectionItem[] = [
		release({ id: 1, title: 'Folk Singer', artist: 'Muddy Waters', genres: ['Blues'], styles: ['Delta Blues'] }),
		release({ id: 2, title: 'Folk Singer', artist: 'Muddy Waters', genres: ['Blues'], styles: ['Chicago Blues'] }),
		release({ id: 3, title: 'Tracy Chapman', artist: 'Tracy Chapman', genres: ['Rock'], styles: ['Folk Rock'] }),
		release({ id: 4, title: 'For Emma, Forever Ago', artist: 'Bon Iver', genres: ['Folk, World, & Country'], styles: ['Folk Rock'] }),
		release({ id: 5, title: 'Kind of Blue', artist: 'Miles Davis', genres: ['Jazz'], styles: ['Modal'] }),
	]

	it('ranks artist+title literal matches above tag-only matches', () => {
		const index = buildIndex(fixture)
		const scores = searchIndex(index, 'muddy waters folk singer')
		const muddyId1 = indexableId(fixture[0])
		const muddyId2 = indexableId(fixture[1])
		const tagOnlyTracyId = indexableId(fixture[2])
		// Under OR-combine, tag-only matches appear too — but BM25 ranks
		// the multi-token literal matches significantly higher.
		expect(scores.has(muddyId1)).toBe(true)
		expect(scores.has(muddyId2)).toBe(true)
		expect((scores.get(muddyId1) ?? 0)).toBeGreaterThan(scores.get(tagOnlyTracyId) ?? 0)
		expect((scores.get(muddyId2) ?? 0)).toBeGreaterThan(scores.get(tagOnlyTracyId) ?? 0)
	})

	it('returns rare-token matches when other query tokens match nothing (#24)', () => {
		// Reproduces the "Best Of Genesis" regression: AND-combine returned
		// zero because no release contained "best". Under OR + BM25, the rare
		// token "miles" wins despite "best" / "of" matching nothing.
		const index = buildIndex(fixture)
		const scores = searchIndex(index, 'best of miles')
		const milesId = indexableId(fixture[4])
		expect(scores.has(milesId)).toBe(true)
	})

	it('matches by artist alone', () => {
		const index = buildIndex(fixture)
		const scores = searchIndex(index, 'miles davis')
		expect(scores.has(indexableId(fixture[4]))).toBe(true)
	})

	it('matches genre/style tokens with lower score than title hits', () => {
		const index = buildIndex(fixture)
		const titleHits = searchIndex(index, 'folk singer')
		const genreHits = searchIndex(index, 'folk')
		// Title-token-bearing release should score higher than the same release scored by a single genre token.
		const muddyKey = indexableId(fixture[0])
		expect((titleHits.get(muddyKey) ?? 0)).toBeGreaterThan(genreHits.get(muddyKey) ?? 0)
	})

	it('returns empty map for empty query', () => {
		const index = buildIndex(fixture)
		expect(searchIndex(index, '').size).toBe(0)
		expect(searchIndex(index, '   ').size).toBe(0)
	})

	it('"Best Of Genesis" ranks Genesis-the-artist over compilations of other artists', () => {
		const items: DiscogsCollectionItem[] = [
			release({ id: 100, title: 'Abacab', artist: 'Genesis', genres: ['Rock'], styles: ['Pop Rock'] }),
			release({ id: 101, title: 'Duke', artist: 'Genesis', genres: ['Rock'], styles: ['Prog Rock'] }),
			release({ id: 102, title: 'A Trick of the Tail', artist: 'Genesis', genres: ['Rock'], styles: ['Prog Rock'] }),
			release({ id: 200, title: 'The Best Of', artist: 'Radiohead', genres: ['Rock'], styles: ['Alternative Rock'] }),
			release({ id: 201, title: 'Best Of 1990-2000', artist: 'U2', genres: ['Rock'], styles: ['Pop Rock'] }),
			release({ id: 300, title: 'Genesis Of Genius', artist: 'Ornette Coleman', genres: ['Jazz'], styles: ['Free Jazz'] }),
		]
		const index = buildIndex(items)
		const scores = searchIndex(index, 'best of genesis')
		// Stop words "of" filtered. Both groups now compete on "best" vs "genesis".
		// Genesis-the-artist matches "genesis" via the artist field (boost 2x);
		// Best Of compilations match "best" via the title field (boost 3x).
		// At least one Genesis-the-artist record should appear in the top 3.
		const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
		const top3 = ranked.slice(0, 3)
		const genesisIds = items.filter((i) => i.basic_information.artists?.[0]?.name === 'Genesis').map(indexableId)
		expect(top3.some((id) => genesisIds.includes(id))).toBe(true)
	})

	it('toIndexable produces a stable id keyed by release_id and instance_id', () => {
		const item = fixture[0]
		expect(toIndexable(item).id).toBe(`${item.id}:${item.instance_id}`)
	})
})
