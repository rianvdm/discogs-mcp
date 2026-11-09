// ABOUTME: Tests for the per-user record of the last sync run: outcome classes,
// ABOUTME: failure-streak bookkeeping, error trimming, TTL, and tolerance of bad KV.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { recordSyncOutcome, readLastSyncRecord } from '../../src/sync/lastOutcome'
import { lastOutcomeKey } from '../../src/sync/keys'
import type { SyncOutcome } from '../../src/sync/types'

const ID = 'u1'
const T0 = new Date('2026-11-01T00:00:00.000Z')
const T1 = new Date('2026-11-01T06:00:00.000Z')
const T2 = new Date('2026-11-01T12:00:00.000Z')

async function record(outcome: SyncOutcome, at: Date, error?: string): Promise<void> {
	await recordSyncOutcome(env.MCP_SESSIONS, ID, { outcome, pagesFetched: 1, ...(error ? { error } : {}) }, 'scheduled', at)
}

/** A KV namespace that delegates to `inner`, with `put` swapped for `put`. */
function kvWithPut(inner: KVNamespace, put: (key: string, value: string, options?: KVNamespacePutOptions) => Promise<void>): KVNamespace {
	return {
		get: inner.get.bind(inner),
		list: inner.list.bind(inner),
		delete: inner.delete.bind(inner),
		getWithMetadata: inner.getWithMetadata.bind(inner),
		put,
	} as unknown as KVNamespace
}

describe('recordSyncOutcome', () => {
	beforeEach(async () => {
		const list = await env.MCP_SESSIONS.list({ prefix: 'collection:' })
		for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
	})

	it('starts a streak at 1 with no healthy run on a first failure', async () => {
		await record('failed', T0, 'HTTP 429: throttled')

		const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
		expect(rec).toMatchObject({
			schemaVersion: 1,
			outcome: 'failed',
			trigger: 'scheduled',
			at: T0.toISOString(),
			pagesFetched: 1,
			error: 'HTTP 429: throttled',
			consecutiveFailures: 1,
			lastHealthyAt: null,
		})
	})

	it('increments the streak and carries lastHealthyAt forward across failures', async () => {
		await record('completed', T0)
		await record('failed', T1, 'HTTP 429')
		await record('crashed', T2, 'boom')

		const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
		expect(rec?.consecutiveFailures).toBe(2)
		expect(rec?.lastHealthyAt).toBe(T0.toISOString())
		expect(rec?.outcome).toBe('crashed')
	})

	for (const healthy of ['completed', 'resumed', 'skipped'] as const) {
		it(`resets on ${healthy}`, async () => {
			await record('failed', T0, 'x')
			await record('failed', T1, 'x')
			await record(healthy, T2)

			const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
			expect(rec?.consecutiveFailures).toBe(0)
			expect(rec?.lastHealthyAt).toBe(T2.toISOString())
		})
	}

	it('counts token_invalid as a failure', async () => {
		await record('completed', T0)
		await record('token_invalid', T1, 'HTTP 401')

		const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
		expect(rec?.consecutiveFailures).toBe(1)
		expect(rec?.lastHealthyAt).toBe(T0.toISOString())
	})

	for (const neutral of ['no_token', 'in_progress'] as const) {
		it(`carries both counters unchanged for ${neutral}`, async () => {
			await record('completed', T0)
			await record('failed', T1, 'x')
			await record(neutral, T2)

			const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
			expect(rec?.outcome).toBe(neutral)
			expect(rec?.consecutiveFailures).toBe(1)
			expect(rec?.lastHealthyAt).toBe(T0.toISOString())
		})
	}

	it('ignores a previous record with another schemaVersion', async () => {
		await env.MCP_SESSIONS.put(lastOutcomeKey(ID), JSON.stringify({ schemaVersion: 2, consecutiveFailures: 7, lastHealthyAt: 'x' }))
		await record('failed', T0, 'x')

		const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
		expect(rec?.consecutiveFailures).toBe(1)
		expect(rec?.lastHealthyAt).toBeNull()
	})

	it('starts a fresh streak over a schemaVersion 1 record with invalid fields', async () => {
		await env.MCP_SESSIONS.put(lastOutcomeKey(ID), JSON.stringify({ schemaVersion: 1, consecutiveFailures: '7', lastHealthyAt: {} }))
		await record('failed', T0, 'x')

		const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
		expect(rec?.consecutiveFailures).toBe(1)
		expect(rec?.lastHealthyAt).toBeNull()
	})

	it('ignores a previous record that is not valid JSON', async () => {
		await env.MCP_SESSIONS.put(lastOutcomeKey(ID), '{nope')
		await record('failed', T0, 'x')

		const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
		expect(rec?.consecutiveFailures).toBe(1)
		expect(rec?.lastHealthyAt).toBeNull()
	})

	it('collapses whitespace and truncates the error to 500 characters', async () => {
		await record('failed', T0, 'HTTP 502: <html>\n  <body>' + 'x'.repeat(1000))

		const rec = await readLastSyncRecord(env.MCP_SESSIONS, ID)
		expect(rec?.error).toBeDefined()
		expect(rec?.error).not.toContain('\n')
		expect(rec?.error).not.toContain('  ')
		expect(rec?.error?.startsWith('HTTP 502: <html> <body>x')).toBe(true)
		expect(rec?.error).toHaveLength(500)
	})

	it('sets a 30-day TTL', async () => {
		const put = vi.fn(async (key: string, value: string, options?: KVNamespacePutOptions) => env.MCP_SESSIONS.put(key, value, options))
		await recordSyncOutcome(kvWithPut(env.MCP_SESSIONS, put), ID, { outcome: 'completed', pagesFetched: 1 }, 'manual', T0)

		expect(put).toHaveBeenCalledTimes(1)
		expect(put).toHaveBeenCalledWith(lastOutcomeKey(ID), expect.any(String), { expirationTtl: 2_592_000 })
	})

	it('does not throw when the KV write fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const failing = kvWithPut(env.MCP_SESSIONS, async () => {
			throw new Error('KV put() limit exceeded for the day')
		})

		await expect(recordSyncOutcome(failing, ID, { outcome: 'failed', pagesFetched: 0 }, 'scheduled', T0)).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalledTimes(1)

		warn.mockRestore()
	})
})

describe('readLastSyncRecord', () => {
	beforeEach(async () => {
		await env.MCP_SESSIONS.delete(lastOutcomeKey(ID))
	})

	it('returns null when nothing is stored', async () => {
		expect(await readLastSyncRecord(env.MCP_SESSIONS, ID)).toBeNull()
	})

	it('returns null for a schemaVersion 1 record whose fields are the wrong type', async () => {
		await env.MCP_SESSIONS.put(lastOutcomeKey(ID), JSON.stringify({ schemaVersion: 1, consecutiveFailures: '7', lastHealthyAt: {} }))
		expect(await readLastSyncRecord(env.MCP_SESSIONS, ID)).toBeNull()
	})

	it('returns null for a value that is not valid JSON', async () => {
		await env.MCP_SESSIONS.put(lastOutcomeKey(ID), '{nope')
		expect(await readLastSyncRecord(env.MCP_SESSIONS, ID)).toBeNull()
	})
})
