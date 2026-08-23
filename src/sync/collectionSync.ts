// ABOUTME: Background-syncs a user's Discogs collection into a KV snapshot.
// ABOUTME: Resumable via per-page keys; readers always see a complete snapshot.

import type { DiscogsCollectionResponse } from '../clients/discogs'
import { lastForcedFullSyncKey, pageKey, progressKey, snapshotKey } from './keys'
import {
	toSnapshotItem,
	type ProgressBlob,
	type SnapshotBlob,
	type SnapshotItem,
	type SyncOptions,
	type SyncOutcome,
	type SyncResult,
} from './types'

export interface SyncClient {
	fetchCollectionPage(opts: { page: number; per_page: number; sort: string; sort_order: string }): Promise<DiscogsCollectionResponse>
}

const PER_PAGE = 100
const RETRY_DELAYS_MS = [1000, 2000, 4000]
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const SEVEN_DAYS_S = 7 * 24 * 60 * 60

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

async function readStoredPage(kv: KVNamespace, numericId: string, page: number): Promise<SnapshotItem[]> {
	const items = (await kv.get(pageKey(numericId, page), 'json')) as SnapshotItem[] | null
	if (!items) throw new Error(`sync ${numericId}: stored page ${page} missing`)
	return items
}

/**
 * Why pages are stored individually: the per-invocation CPU budget on Workers
 * Free is 10 ms, and JSON work is the only CPU this sync does. Persisting the
 * whole collection-so-far on every page would make each step cost O(items),
 * which for a few thousand items exceeds the budget on its own and the sync
 * can never advance past that page. With one key per page each step costs
 * O(page); the single O(collection) stringify happens once, at commit.
 *
 * Page keys are left to expire (same TTL as progress) rather than deleted:
 * KV deletes count as writes against the free-plan daily write cap, and a
 * later sync overwrites pages 1..N before it ever reads them.
 */
export async function syncCollection(client: SyncClient, kv: KVNamespace, numericId: string, opts: SyncOptions): Promise<SyncResult> {
	const nowDate = (opts.now ?? (() => new Date()))()
	const now = nowDate.toISOString()
	const nowMs = nowDate.getTime()
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

	const existingProgressRaw = (await kv.get(progressKey(numericId), 'json')) as Partial<ProgressBlob> | null
	const progressIsFresh =
		existingProgressRaw?.schemaVersion === 2 &&
		typeof existingProgressRaw.startedAt === 'string' &&
		nowMs - new Date(existingProgressRaw.startedAt).getTime() < SEVEN_DAYS_MS

	let resumed = false
	// Anchors both the 7-day freshness window and the page-key TTLs, so a
	// resumed sync's pages and its progress record expire together.
	let startedAt = now
	let totalPages = 1
	let totalCount = 0
	let lastPageFetched = 0
	let startPage = 1
	// Page 1 of the current run, kept in memory so the commit doesn't re-read it
	// and so a probe-tripped sync can reuse the probe response as page 1.
	let firstPage: SnapshotItem[] | null = null

	if (progressIsFresh && existingProgressRaw) {
		const progress = existingProgressRaw as ProgressBlob
		resumed = true
		startedAt = progress.startedAt
		totalPages = progress.totalPages
		totalCount = progress.totalCount
		lastPageFetched = progress.lastPageFetched
		startPage = progress.lastPageFetched + 1
	}

	if (!resumed && !opts.force) {
		// Probe gate: only runs when both a snapshot exists AND a recent
		// lastForcedFullSync is on file. On a fresh deploy neither key exists,
		// so this block is skipped and we fall through to a full pagination
		// (the bootstrap path). Don't "fix" the gate to run probe whenever a
		// snapshot exists — that would skip the weekly forced full sweep.
		const existingSnapshot = (await kv.get(snapshotKey(numericId), 'json')) as SnapshotBlob | null
		const lastForced = await kv.get(lastForcedFullSyncKey(numericId))
		const lastForcedFresh = lastForced && nowMs - new Date(lastForced).getTime() < SEVEN_DAYS_MS

		if (existingSnapshot && lastForcedFresh) {
			// Run probe: fetch page 1, compare count + top instance_ids
			const probe = await fetchPageWithRetry(client, 1, sleep)
			const probeTopIds = probe.releases.map((r) => r.instance_id)
			const sameCount = probe.pagination.items === existingSnapshot.count
			const sameTopIds =
				probeTopIds.length === existingSnapshot.topPageInstanceIds.length &&
				probeTopIds.every((id, i) => id === existingSnapshot.topPageInstanceIds[i])

			if (sameCount && sameTopIds) {
				return {
					outcome: 'skipped',
					pagesFetched: 1,
					count: existingSnapshot.count,
					fetchedAt: existingSnapshot.fetchedAt,
				}
			}

			// Probe tripped — reuse the page-1 response as the first page of the full sync
			totalPages = probe.pagination.pages
			totalCount = probe.pagination.items
			firstPage = probe.releases.map(toSnapshotItem)
			lastPageFetched = 1
			startPage = 2
			await persistPage(kv, numericId, 1, firstPage, totalPages, totalCount, startedAt)
		}
	}

	try {
		for (let page = startPage; page <= totalPages; page++) {
			const res = await fetchPageWithRetry(client, page, sleep)
			if (page === 1) {
				totalPages = res.pagination.pages
				totalCount = res.pagination.items
			}
			// Drift check: every page's pagination.items must match the totalCount
			// recorded on page 1 (or carried forward from progress on resume). Discogs
			// returns the live count in every page response, so any disagreement means
			// the collection changed mid-sync. Skip the check on page 1 itself — that's
			// the page that defines totalCount.
			if (page > 1 && res.pagination.items !== totalCount) {
				await kv.delete(progressKey(numericId))
				return syncCollection(client, kv, numericId, { ...opts, force: true })
			}
			const items = res.releases.map(toSnapshotItem)
			if (page === 1) firstPage = items
			lastPageFetched = page
			await persistPage(kv, numericId, page, items, totalPages, totalCount, startedAt)
		}
	} catch (err) {
		return {
			outcome: 'failed',
			pagesFetched: lastPageFetched,
			error: err instanceof Error ? err.message : String(err),
		}
	}

	// Assemble: pages are in date_added desc order, so page 1 is the newest
	// items and doubles as the probe fingerprint.
	const items: SnapshotItem[] = []
	let topPageInstanceIds: number[] = []
	for (let page = 1; page <= totalPages; page++) {
		let stored: SnapshotItem[]
		try {
			stored = page === 1 && firstPage ? firstPage : await readStoredPage(kv, numericId, page)
		} catch {
			// A page key expired (or was never written) under a progress record
			// that still claims it. Committing would leave a hole, so start over.
			await kv.delete(progressKey(numericId))
			return syncCollection(client, kv, numericId, { ...opts, force: true })
		}
		if (page === 1) topPageInstanceIds = stored.map((i) => i.instance_id)
		items.push(...stored)
	}

	const snapshot: SnapshotBlob = {
		schemaVersion: 1,
		fetchedAt: now,
		count: totalCount,
		topPageInstanceIds,
		items,
	}
	const snapshotJson = JSON.stringify(snapshot)
	// KV value limit is 25MB. Slimmed items run ~450B each, so even a 10,000-item
	// collection stays under 5MB. Logged so growth is visible before it matters.
	console.log(`sync ${numericId}: snapshot size ${snapshotJson.length} bytes, ${totalCount} items`)
	await kv.put(snapshotKey(numericId), snapshotJson)
	await kv.put(lastForcedFullSyncKey(numericId), now)
	await kv.delete(progressKey(numericId))

	const outcome: SyncOutcome = resumed ? 'resumed' : 'completed'
	return { outcome, pagesFetched: lastPageFetched, count: totalCount, fetchedAt: now }
}

/**
 * Write one fetched page, then advance the progress record. Order matters: a
 * CPU-limit kill between the two leaves a page key without a progress pointer
 * to it, which the next run simply overwrites — never the reverse.
 */
async function persistPage(
	kv: KVNamespace,
	numericId: string,
	page: number,
	items: SnapshotItem[],
	totalPages: number,
	totalCount: number,
	startedAt: string,
): Promise<void> {
	await kv.put(pageKey(numericId, page), JSON.stringify(items), { expirationTtl: SEVEN_DAYS_S })
	const progress: ProgressBlob = { schemaVersion: 2, startedAt, totalPages, totalCount, lastPageFetched: page }
	await kv.put(progressKey(numericId), JSON.stringify(progress), { expirationTtl: SEVEN_DAYS_S })
}
