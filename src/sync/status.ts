// ABOUTME: Human-readable summary of a user's collection snapshot, any sync in flight,
// ABOUTME: and the last sync's outcome. Read by get_cache_stats to diagnose sync health.

import { describeAge } from '../utils/age'
import { progressKey, snapshotKey } from './keys'
import { isFailingOutcome, readLastSyncRecord } from './lastOutcome'
import type { LastSyncRecord, ProgressBlob, SnapshotBlob, SyncOutcome } from './types'

const OUTCOME_LABELS: Record<SyncOutcome, string> = {
	completed: 'completed',
	resumed: 'completed (resumed a partial sweep)',
	skipped: 'skipped (no changes)',
	failed: 'FAILED',
	crashed: 'CRASHED',
	token_invalid: 'FAILED (Discogs rejected the stored token; sign in again)',
	no_token: 'not run (no stored Discogs token; sign in once to enable background sync)',
	in_progress: 'in progress',
}

const THROTTLED_HINT =
	'Discogs is throttling requests from this Worker\'s IP. If this keeps happening, route Discogs calls through your own IP (README: "Route Discogs calls through your own IP"); ping shows the current egress.'

export async function describeSyncState(kv: KVNamespace, numericId: string, now: number = Date.now()): Promise<string[]> {
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

	lines.push(...describeLastSync(await readLastSyncRecord(kv, numericId), now))
	return lines
}

/**
 * The last run's outcome, plus the failure streak and error when it failed.
 * The snapshot's fetch time alone can't show this: a skipped run is healthy but
 * leaves fetchedAt where it was, and a failing one leaves it there too.
 */
function describeLastSync(record: LastSyncRecord | null, now: number): string[] {
	if (!record) return ['Last sync: none recorded yet']

	const trigger = record.trigger === 'manual' ? 'manual refresh' : 'scheduled'
	const lines = [`Last sync: ${OUTCOME_LABELS[record.outcome]}, ${trigger}, ${describeAge(Date.parse(record.at), now)}`]
	if (record.consecutiveFailures > 0) {
		const lastHealthy = record.lastHealthyAt ? describeAge(Date.parse(record.lastHealthyAt), now) : 'not recorded yet'
		lines.push(`Failures in a row: ${record.consecutiveFailures}; last healthy run ${lastHealthy}`)
	}
	if (record.error) lines.push(`Error: ${record.error}`)
	if (isFailingOutcome(record.outcome) && record.error?.includes('HTTP 429')) lines.push(THROTTLED_HINT)
	return lines
}
