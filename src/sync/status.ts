// ABOUTME: Human-readable summary of a user's collection snapshot and any sync in flight.
// ABOUTME: Read by get_cache_stats so sync health is diagnosable from an MCP client.

import { progressKey, snapshotKey } from './keys'
import type { ProgressBlob, SnapshotBlob } from './types'

export async function describeSyncState(kv: KVNamespace, numericId: string): Promise<string[]> {
	const lines: string[] = []

	// The snapshot is parsed whole here, the same cost every search pays.
	const snapshot = (await kv.get(snapshotKey(numericId), 'json')) as SnapshotBlob | null
	if (snapshot) {
		lines.push(`Collection snapshot: ${snapshot.count} items, fetched ${snapshot.fetchedAt}`)
	} else {
		lines.push('Collection snapshot: none (collection queries fall back to the live Discogs API until the first sync completes)')
	}

	const progress = (await kv.get(progressKey(numericId), 'json')) as Partial<ProgressBlob> | null
	if (progress?.schemaVersion === 2) {
		lines.push(`Sync in progress: page ${progress.lastPageFetched} of ${progress.totalPages}, started ${progress.startedAt}`)
	}

	return lines
}
