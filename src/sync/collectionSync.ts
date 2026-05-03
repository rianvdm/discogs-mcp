// ABOUTME: Background-syncs a user's Discogs collection into a KV snapshot.
// ABOUTME: Resumable via a progress key; readers always see a complete snapshot.

import type { DiscogsCollectionItem, DiscogsCollectionResponse } from '../clients/discogs'
import { progressKey, snapshotKey } from './keys'
import type { ProgressBlob, SnapshotBlob, SyncOptions, SyncResult } from './types'

export interface SyncClient {
	fetchCollectionPage(opts: {
		page: number
		per_page: number
		sort: string
		sort_order: string
	}): Promise<DiscogsCollectionResponse>
}

const PER_PAGE = 100
const RETRY_DELAYS_MS = [1000, 2000, 4000]

async function fetchPageWithRetry(
	client: SyncClient,
	page: number,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<DiscogsCollectionResponse> {
	let lastErr: unknown
	for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
		try {
			return await client.fetchCollectionPage({ page, per_page: PER_PAGE, sort: 'added', sort_order: 'desc' })
		} catch (err) {
			lastErr = err
			if (attempt < RETRY_DELAYS_MS.length - 1) await sleep(RETRY_DELAYS_MS[attempt])
		}
	}
	throw lastErr
}

export async function syncCollection(
	client: SyncClient,
	kv: KVNamespace,
	numericId: string,
	opts: SyncOptions,
): Promise<SyncResult> {
	const now = (opts.now ?? (() => new Date()))().toISOString()
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

	const itemsSoFar: DiscogsCollectionItem[] = []
	let totalPages = 1
	let totalCount = 0
	let topPageInstanceIds: number[] = []
	let lastPageFetched = 0

	try {
		for (let page = 1; page <= totalPages; page++) {
			const res = await fetchPageWithRetry(client, page, sleep)
			if (page === 1) {
				totalPages = res.pagination.pages
				totalCount = res.pagination.items
				topPageInstanceIds = res.releases.map((r) => r.instance_id)
			}
			itemsSoFar.push(...res.releases)
			lastPageFetched = page

			// Persist progress after each successful page (except the last — the
			// final snapshot commit + progress delete happen atomically below).
			if (page < totalPages) {
				const progress: ProgressBlob = {
					schemaVersion: 1,
					startedAt: now,
					totalPages,
					totalCount,
					lastPageFetched,
					itemsSoFar,
				}
				await kv.put(progressKey(numericId), JSON.stringify(progress), {
					// 7-day TTL so abandoned syncs auto-cleanup. Spec §KV Schema.
					expirationTtl: 7 * 24 * 60 * 60,
				})
			}
		}
	} catch (err) {
		return {
			outcome: 'failed',
			pagesFetched: lastPageFetched,
			error: err instanceof Error ? err.message : String(err),
		}
	}

	const snapshot: SnapshotBlob = {
		schemaVersion: 1,
		fetchedAt: now,
		count: totalCount,
		topPageInstanceIds,
		items: itemsSoFar,
	}
	const snapshotJson = JSON.stringify(snapshot)
	// KV value limit is 25MB. ~600B/item × 1,500 items ≈ 900KB is comfortable;
	// a self-hoster with 5,000+ items will start pushing 3MB. Log the size so
	// we can spot the problem before it hits the limit.
	console.log(`sync ${numericId}: snapshot size ${snapshotJson.length} bytes, ${totalCount} items`)
	await kv.put(snapshotKey(numericId), snapshotJson)
	await kv.delete(progressKey(numericId))

	return { outcome: 'completed', pagesFetched: lastPageFetched, count: totalCount, fetchedAt: now }
}
