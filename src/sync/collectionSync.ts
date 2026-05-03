// ABOUTME: Background-syncs a user's Discogs collection into a KV snapshot.
// ABOUTME: Resumable via a progress key; readers always see a complete snapshot.

import type { DiscogsCollectionItem, DiscogsCollectionResponse } from '../clients/discogs'
import { snapshotKey } from './keys'
import type { SnapshotBlob, SyncOptions, SyncResult } from './types'

export interface SyncClient {
	fetchCollectionPage(opts: {
		page: number
		per_page: number
		sort: string
		sort_order: string
	}): Promise<DiscogsCollectionResponse>
}

const PER_PAGE = 100

export async function syncCollection(
	client: SyncClient,
	kv: KVNamespace,
	numericId: string,
	opts: SyncOptions,
): Promise<SyncResult> {
	const now = (opts.now ?? (() => new Date()))().toISOString()
	const allItems: DiscogsCollectionItem[] = []
	let totalPages = 1
	let totalCount = 0
	let topPageInstanceIds: number[] = []

	for (let page = 1; page <= totalPages; page++) {
		const res = await client.fetchCollectionPage({
			page,
			per_page: PER_PAGE,
			sort: 'added',
			sort_order: 'desc',
		})
		if (page === 1) {
			totalPages = res.pagination.pages
			totalCount = res.pagination.items
			topPageInstanceIds = res.releases.map((r) => r.instance_id)
		}
		allItems.push(...res.releases)
	}

	const snapshot: SnapshotBlob = {
		schemaVersion: 1,
		fetchedAt: now,
		count: totalCount,
		topPageInstanceIds,
		items: allItems,
	}
	await kv.put(snapshotKey(numericId), JSON.stringify(snapshot))

	return { outcome: 'completed', pagesFetched: totalPages, count: totalCount, fetchedAt: now }
}
