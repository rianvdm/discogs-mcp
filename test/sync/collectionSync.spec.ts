import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { syncCollection, type SyncClient } from '../../src/sync/collectionSync'
import { snapshotKey, progressKey, pageKey, lastForcedFullSyncKey } from '../../src/sync/keys'
import { toSnapshotItem, type SnapshotBlob, type SnapshotItem, type ProgressBlob } from '../../src/sync/types'
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

	it('stores only the fields readers use, dropping image URLs and nested ids', async () => {
		const raw = makeItem(1, 101)
		raw.basic_information.thumb = 'https://i.discogs.com/thumb.jpg'
		raw.basic_information.cover_image = 'https://i.discogs.com/cover.jpg'
		raw.basic_information.resource_url = 'https://api.discogs.com/releases/1'
		raw.basic_information.master_url = 'https://api.discogs.com/masters/1'
		raw.basic_information.master_id = 77
		const client: SyncClient = {
			async fetchCollectionPage() {
				return makePage([raw], 1, 1, 1)
			},
		}

		await syncCollection(client, env.MCP_SESSIONS, 'u', {})

		const snapshot = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
		expect(snapshot?.items).toHaveLength(1)
		expect(snapshot?.items[0]).toEqual({
			id: 1,
			instance_id: 101,
			folder_id: 0,
			date_added: '2026-01-01T00:00:00Z',
			rating: 0,
			basic_information: {
				id: 1,
				master_id: 77,
				title: 'Album 1',
				year: 2020,
				formats: [{ name: 'Vinyl', qty: '1' }],
				labels: [{ name: 'Label', catno: 'CAT-1' }],
				artists: [{ name: 'Artist' }],
				genres: ['Rock'],
				styles: ['Pop'],
			},
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

	it('retries a transient page failure up to 3 times', async () => {
		let attempts = 0
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				if (opts.page === 1) {
					attempts++
					if (attempts < 3) throw new Error('500 Internal Server Error')
					return makePage([makeItem(1, 101)], 1, 1, 1)
				}
				throw new Error('unreachable')
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
		expect(result.outcome).toBe('completed')
		expect(attempts).toBe(3)
	})

	it('persists progress and leaves snapshot untouched when retries are exhausted', async () => {
		const prev: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: '2026-01-01T00:00:00Z',
			count: 1,
			topPageInstanceIds: [999],
			items: [makeItem(99, 999)],
		}
		await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))

		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				if (opts.page === 1) return makePage([makeItem(1, 101)], 1, 3, 3)
				if (opts.page === 2) return makePage([makeItem(2, 102)], 2, 3, 3)
				throw new Error('500 on page 3')
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })

		expect(result.outcome).toBe('failed')
		expect(result.pagesFetched).toBe(2)

		// Snapshot still the previous one
		const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
		expect(snap?.count).toBe(1)

		// Progress recorded as metadata only; fetched pages live under their own keys
		const prog = await env.MCP_SESSIONS.get<ProgressBlob>(progressKey('u'), 'json')
		expect(prog?.lastPageFetched).toBe(2)
		expect(prog?.totalPages).toBe(3)
		expect(prog?.totalCount).toBe(3)
		expect(prog).not.toHaveProperty('itemsSoFar')
		const page1 = await env.MCP_SESSIONS.get<SnapshotItem[]>(pageKey('u', 1), 'json')
		const page2 = await env.MCP_SESSIONS.get<SnapshotItem[]>(pageKey('u', 2), 'json')
		expect(page1?.map((i) => i.instance_id)).toEqual([101])
		expect(page2?.map((i) => i.instance_id)).toEqual([102])
		expect(page1?.[0]).not.toHaveProperty('basic_information.thumb')
		expect(await env.MCP_SESSIONS.get(pageKey('u', 3))).toBeNull()
	})

	it('keeps per-page progress writes bounded by page size, not collection size', async () => {
		// Each page write must serialise only that page. The sync is observed
		// through the KV namespace: no key other than the snapshot may ever hold
		// more than one page's worth of items.
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				return makePage([makeItem(opts.page, opts.page * 100)], opts.page, 3, 3)
			},
		}

		await syncCollection(client, env.MCP_SESSIONS, 'u', {})

		const list = await env.MCP_SESSIONS.list({ prefix: 'collection:sync:' })
		for (const k of list.keys) {
			const raw = (await env.MCP_SESSIONS.get(k.name)) ?? ''
			let value: unknown
			try {
				value = JSON.parse(raw)
			} catch {
				continue // lastForcedFullSync holds a bare timestamp
			}
			const items = Array.isArray(value) ? value : []
			expect(items.length, k.name).toBeLessThanOrEqual(1)
		}
	})

	it('ignores a progress record with inline items left by an earlier schema and starts fresh', async () => {
		const legacy = {
			schemaVersion: 1,
			startedAt: new Date().toISOString(),
			totalPages: 3,
			totalCount: 3,
			lastPageFetched: 2,
			itemsSoFar: [makeItem(1, 101), makeItem(2, 102)],
		}
		await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify(legacy))

		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				return makePage([makeItem(1, 101)], 1, 1, 1)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
		expect(result.outcome).toBe('completed')
		expect(calls).toEqual([1])
	})

	it('resumes from progress.lastPageFetched + 1 when progress key exists', async () => {
		const progress: ProgressBlob = {
			schemaVersion: 2,
			startedAt: new Date().toISOString(),
			totalPages: 3,
			totalCount: 3,
			lastPageFetched: 2,
		}
		await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify(progress))
		await env.MCP_SESSIONS.put(pageKey('u', 1), JSON.stringify([toSnapshotItem(makeItem(1, 101))]))
		await env.MCP_SESSIONS.put(pageKey('u', 2), JSON.stringify([toSnapshotItem(makeItem(2, 102))]))

		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				if (opts.page === 3) return makePage([makeItem(3, 103)], 3, 3, 3)
				throw new Error(`unexpected page ${opts.page}`)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })

		expect(result.outcome).toBe('resumed')
		expect(calls).toEqual([3])
		const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
		expect(snap?.items.map((i) => i.instance_id)).toEqual([101, 102, 103])
		expect(snap?.count).toBe(3)
		// Page 1 was not refetched, so the probe fingerprint comes from the stored page
		expect(snap?.topPageInstanceIds).toEqual([101])
		// Progress cleaned up
		expect(await env.MCP_SESSIONS.get(progressKey('u'))).toBeNull()
	})

	it('discards progress and restarts when totalCount changes mid-resume', async () => {
		const progress: ProgressBlob = {
			schemaVersion: 2,
			startedAt: new Date().toISOString(), // fresh
			totalPages: 3,
			totalCount: 3,
			lastPageFetched: 2,
		}
		await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify(progress))
		await env.MCP_SESSIONS.put(pageKey('u', 1), JSON.stringify([toSnapshotItem(makeItem(1, 101))]))
		await env.MCP_SESSIONS.put(pageKey('u', 2), JSON.stringify([toSnapshotItem(makeItem(2, 102))]))

		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				// Page 3 reports a different count → drift
				if (opts.page === 3) return makePage([makeItem(3, 103)], 3, 3, 4)
				// Restart from page 1 — collection is now 4 items across 1 page
				if (opts.page === 1) {
					return makePage([makeItem(1, 101), makeItem(2, 102), makeItem(3, 103), makeItem(4, 104)], 1, 1, 4)
				}
				throw new Error(`unexpected page ${opts.page}`)
			},
		}

		await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })

		// Should have fetched page 3 (drift detected) then restarted at page 1
		expect(calls).toEqual([3, 1])
		const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
		expect(snap?.count).toBe(4)
		expect(snap?.items).toHaveLength(4)
	})

	it('restarts from page 1 when a stored page is missing at commit time', async () => {
		// Progress points past page 2, but page 2's key is gone (expired or never
		// written). Resume must not commit a snapshot with a hole in it.
		const progress: ProgressBlob = {
			schemaVersion: 2,
			startedAt: new Date().toISOString(),
			totalPages: 3,
			totalCount: 3,
			lastPageFetched: 2,
		}
		await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify(progress))
		await env.MCP_SESSIONS.put(pageKey('u', 1), JSON.stringify([toSnapshotItem(makeItem(1, 101))]))

		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				return makePage([makeItem(opts.page, opts.page * 100)], opts.page, 3, 3)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })

		expect(calls).toEqual([3, 1, 2, 3])
		expect(result.outcome).toBe('completed')
		const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
		expect(snap?.items.map((i) => i.instance_id)).toEqual([100, 200, 300])
	})

	it('ignores progress older than 7 days and starts fresh', async () => {
		// startedAt 30+ days ago — well outside the 7-day fresh window
		const ancient: ProgressBlob = {
			schemaVersion: 2,
			startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
			totalPages: 3,
			totalCount: 3,
			lastPageFetched: 2,
		}
		await env.MCP_SESSIONS.put(progressKey('u'), JSON.stringify(ancient))

		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				return makePage([makeItem(opts.page, opts.page * 100)], opts.page, 1, 1)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
		expect(result.outcome).toBe('completed') // not "resumed"
		expect(calls[0]).toBe(1) // started fresh
	})

	it('skips full repaginate when count and topPageInstanceIds both match', async () => {
		const prev: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: '2026-05-03T00:00:00Z',
			count: 2,
			topPageInstanceIds: [101, 102],
			items: [makeItem(1, 101), makeItem(2, 102)],
		}
		await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
		// Recent forced full sweep so weekly-sweep doesn't trigger
		await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), new Date().toISOString())

		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				// Same count, same page-1 instance_ids
				return makePage([makeItem(1, 101), makeItem(2, 102)], 1, 1, 2)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
		expect(result.outcome).toBe('skipped')
		expect(calls).toEqual([1]) // only the probe call, no full repaginate
	})

	it('triggers full repaginate when probe count differs from snapshot count', async () => {
		const prev: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: '2026-05-03T00:00:00Z',
			count: 2,
			topPageInstanceIds: [101, 102],
			items: [makeItem(1, 101), makeItem(2, 102)],
		}
		await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
		await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), new Date().toISOString())

		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				// Probe + page 1 of new sync: count is now 3
				if (opts.page === 1) return makePage([makeItem(1, 101), makeItem(2, 102), makeItem(3, 103)], 1, 1, 3)
				throw new Error(`unexpected page ${opts.page}`)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
		expect(result.outcome).toBe('completed')
		expect(result.count).toBe(3)
		// Page 1 fetched once total — probe response is reused as page 1 of the sync
		expect(calls).toEqual([1])
	})

	it('detects add+remove swap when count matches but page-1 instance_ids differ', async () => {
		const prev: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: '2026-05-03T00:00:00Z',
			count: 2,
			topPageInstanceIds: [101, 102],
			items: [makeItem(1, 101), makeItem(2, 102)],
		}
		await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
		await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), new Date().toISOString())

		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				// count=2 still, but instance 102 was removed and 103 was added
				if (opts.page === 1) return makePage([makeItem(1, 101), makeItem(3, 103)], 1, 1, 2)
				throw new Error(`unexpected page ${opts.page}`)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { sleep: async () => {} })
		expect(result.outcome).toBe('completed')
		const snap = await env.MCP_SESSIONS.get<SnapshotBlob>(snapshotKey('u'), 'json')
		expect(snap?.topPageInstanceIds).toEqual([101, 103])
	})

	it('skips probe and runs a full repaginate when force is true', async () => {
		const prev: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: '2026-05-03T00:00:00Z',
			count: 1,
			topPageInstanceIds: [101],
			items: [makeItem(1, 101)],
		}
		await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
		await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), new Date().toISOString())

		const client: SyncClient = {
			async fetchCollectionPage(_opts) {
				// Identical to snapshot — without force, probe would skip
				return makePage([makeItem(1, 101)], 1, 1, 1)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', { force: true, sleep: async () => {} })
		expect(result.outcome).toBe('completed') // not "skipped"
	})

	it('forces full repaginate when lastForcedFullSync is older than 7 days', async () => {
		const prev: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: '2026-04-20T00:00:00Z',
			count: 1,
			topPageInstanceIds: [101],
			items: [makeItem(1, 101)],
		}
		await env.MCP_SESSIONS.put(snapshotKey('u'), JSON.stringify(prev))
		// 8 days before the test's "now" — past the 7-day threshold
		await env.MCP_SESSIONS.put(lastForcedFullSyncKey('u'), '2026-04-25T00:00:00Z')

		const calls: number[] = []
		const client: SyncClient = {
			async fetchCollectionPage(opts) {
				calls.push(opts.page)
				return makePage([makeItem(1, 101)], 1, 1, 1)
			},
		}

		const result = await syncCollection(client, env.MCP_SESSIONS, 'u', {
			sleep: async () => {},
			now: () => new Date('2026-05-03T12:00:00Z'),
		})
		// Probe is gated on lastForcedFresh; with stale lastForced, the gate is skipped
		// and we fall through to a full pagination — outcome 'completed', not 'skipped'.
		expect(result.outcome).toBe('completed')
	})
})
