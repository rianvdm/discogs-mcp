import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { syncCollection, type SyncClient } from '../../src/sync/collectionSync'
import { snapshotKey } from '../../src/sync/keys'
import type { SnapshotBlob } from '../../src/sync/types'
import type { DiscogsCollectionItem, DiscogsCollectionResponse } from '../../src/clients/discogs'

function makeItem(id: number, instanceId: number, dateAdded = '2026-01-01T00:00:00Z'): DiscogsCollectionItem {
	return {
		id,
		instance_id: instanceId,
		folder_id: 0,
		date_added: dateAdded,
		rating: 0,
		basic_information: {
			id,
			title: `Album ${id}`,
			year: 2020,
			resource_url: '',
			thumb: '',
			cover_image: '',
			formats: [{ name: 'Vinyl', qty: '1' }],
			labels: [{ name: 'Label', catno: 'CAT-1' }],
			artists: [{ name: 'Artist', id: 1 }],
			genres: ['Rock'],
			styles: ['Pop'],
		},
	}
}

function makePage(items: DiscogsCollectionItem[], page: number, totalPages: number, totalItems: number): DiscogsCollectionResponse {
	return {
		pagination: { pages: totalPages, page, per_page: 100, items: totalItems, urls: {} },
		releases: items,
	}
}

describe('syncCollection — first-run bootstrap', () => {
	beforeEach(async () => {
		const list = await env.MCP_SESSIONS.list({ prefix: 'collection:' })
		for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
	})

	it('paginates the entire collection and writes a snapshot when none exists', async () => {
		const page1 = [makeItem(1, 101), makeItem(2, 102)]
		const page2 = [makeItem(3, 103)]
		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				if (opts.page === 1) return makePage(page1, 1, 2, 3)
				return makePage(page2, 2, 2, 3)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, '12345', {})

		expect(result.outcome).toBe('completed')
		expect(result.pagesFetched).toBe(2)
		expect(calls).toEqual([1, 2])

		const snapshot = await env.MCP_SESSIONS.get(snapshotKey('12345'), 'json')
		expect(snapshot).toMatchObject({
			schemaVersion: 1,
			count: 3,
			topPageInstanceIds: [101, 102],
			items: expect.arrayContaining([
				expect.objectContaining({ instance_id: 101 }),
				expect.objectContaining({ instance_id: 102 }),
				expect.objectContaining({ instance_id: 103 }),
			]),
		})
	})

	it('does not write to snapshot key until all pages have been fetched', async () => {
		// Pre-populate a previous good snapshot
		const prev: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: '2026-01-01T00:00:00Z',
			count: 1,
			topPageInstanceIds: [999],
			items: [makeItem(99, 999)],
		}
		await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))

		const observed: Array<SnapshotBlob | null> = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				// After each page, peek at the snapshot key
				observed.push(await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json'))
				if (opts.page === 1) return makePage([makeItem(1, 101)], 1, 3, 3)
				if (opts.page === 2) return makePage([makeItem(2, 102)], 2, 3, 3)
				return makePage([makeItem(3, 103)], 3, 3, 3)
			},
		}

		await syncCollection(client, env.MCP_SESSIONS, 'u', {})

		// Every snapshot read during the sync should be the previous snapshot, never a partial.
		for (const snap of observed) {
			expect(snap?.count).toBe(1)
			expect(snap?.topPageInstanceIds).toEqual([999])
		}
		// Final snapshot is the new one
		const final = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
		expect(final?.count).toBe(3)
	})
})
