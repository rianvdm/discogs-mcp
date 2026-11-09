// ABOUTME: Persists the outcome of each user's most recent sync run, with a failure
// ABOUTME: streak and the time of the last healthy run, for get_cache_stats to report.

import { lastOutcomeKey } from './keys'
import type { LastSyncRecord, SyncOutcome, SyncResult, SyncTrigger } from './types'

const MAX_ERROR_LENGTH = 500
/** A user dropped from the allowlist stops syncing; their record lapses after this. */
const RECORD_TTL_S = 30 * 24 * 60 * 60

const HEALTHY: ReadonlySet<SyncOutcome> = new Set(['completed', 'resumed', 'skipped'])
const FAILING: ReadonlySet<SyncOutcome> = new Set(['failed', 'crashed', 'token_invalid'])

/** The stored record, or null when there is none or it can't be read as this schema. Never throws. */
export async function readLastSyncRecord(kv: KVNamespace, numericId: string): Promise<LastSyncRecord | null> {
	try {
		const raw = (await kv.get(lastOutcomeKey(numericId), 'json')) as Partial<LastSyncRecord> | null
		return raw?.schemaVersion === 1 ? (raw as LastSyncRecord) : null
	} catch {
		return null
	}
}

/**
 * Record a finished sync run. Healthy outcomes reset the failure streak, failing
 * ones extend it, and neutral ones (no_token, in_progress) carry it forward.
 *
 * The read-modify-write is unguarded on purpose: overlapping runs are allowed
 * (see refresh_collection), so two finishing together can lose one increment or
 * let the older result land last. That's acceptable for a diagnostic. A KV
 * failure is logged and swallowed, because losing this record must never fail
 * the sync or the tool call that triggered it.
 */
export async function recordSyncOutcome(
	kv: KVNamespace,
	numericId: string,
	result: SyncResult,
	trigger: SyncTrigger,
	now: Date = new Date(),
): Promise<void> {
	try {
		const previous = await readLastSyncRecord(kv, numericId)
		const at = now.toISOString()
		let consecutiveFailures = previous?.consecutiveFailures ?? 0
		let lastHealthyAt = previous?.lastHealthyAt ?? null
		if (HEALTHY.has(result.outcome)) {
			consecutiveFailures = 0
			lastHealthyAt = at
		} else if (FAILING.has(result.outcome)) {
			consecutiveFailures += 1
		}

		const record: LastSyncRecord = {
			schemaVersion: 1,
			outcome: result.outcome,
			trigger,
			at,
			pagesFetched: result.pagesFetched,
			...(result.count !== undefined ? { count: result.count } : {}),
			...(result.error ? { error: trimError(result.error) } : {}),
			consecutiveFailures,
			lastHealthyAt,
		}
		await kv.put(lastOutcomeKey(numericId), JSON.stringify(record), { expirationTtl: RECORD_TTL_S })
	} catch (err) {
		console.warn(`sync ${numericId}: could not record the sync outcome: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/** One line, bounded: error bodies can be whole HTML pages from a relay or proxy. */
function trimError(error: string): string {
	return error.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH)
}
