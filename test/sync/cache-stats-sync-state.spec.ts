import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { McpServer } from '@modelcontextprotocol/server'
import { registerAuthenticatedTools } from '../../src/mcp/tools/authenticated'
import { snapshotKey, progressKey, lastOutcomeKey } from '../../src/sync/keys'
import type { LastSyncRecord, ProgressBlob, SnapshotBlob } from '../../src/sync/types'

// Keep tool registration off the network and the rate-limiter DO.
vi.mock('../../src/clients/discogs', async (orig) => {
	const actual = (await orig()) as object
	return {
		...actual,
		DiscogsClient: vi.fn().mockImplementation(function () {
			return {
				setRateLimiter: vi.fn(),
			}
		}),
	}
})

const fakeSession = () => ({
	session: {
		userId: '12345',
		username: 'u',
		numericId: '12345',
		accessToken: 'tok',
		accessTokenSecret: 'sec',
		iat: 0,
		exp: 0,
	},
	connectionId: 'conn-1',
})

function buildServer() {
	const server = new McpServer({ name: 'test', version: '0.0.0' })
	registerAuthenticatedTools(server, env as any, async () => fakeSession() as any)
	return server
}

async function callCacheStats(server: McpServer): Promise<string> {
	const tools = (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
			>
		}
	)._registeredTools
	const tool = tools['get_cache_stats']
	if (!tool) throw new Error('get_cache_stats tool not registered')
	const res = await tool.handler({}, {})
	return res.content[0].text
}

describe('get_cache_stats — collection sync state', () => {
	beforeEach(async () => {
		for (const prefix of ['collection:', 'cache:']) {
			const list = await env.MCP_SESSIONS.list({ prefix })
			for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
		}
	})

	it('reports that no snapshot exists yet', async () => {
		const text = await callCacheStats(buildServer())
		expect(text).toContain('Collection snapshot: none')
	})

	it('reports snapshot item count and fetch time', async () => {
		const snapshot: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: '2026-08-20T01:23:00.000Z',
			count: 4153,
			topPageInstanceIds: [],
			items: [],
		}
		await env.MCP_SESSIONS.put(snapshotKey('12345'), JSON.stringify(snapshot))

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Collection snapshot: 4153 items, fetched 2026-08-20T01:23:00.000Z')
	})

	it('reports an in-flight sync with pages completed', async () => {
		const progress: ProgressBlob = {
			schemaVersion: 2,
			startedAt: '2026-08-22T07:23:00.000Z',
			totalPages: 42,
			totalCount: 4153,
			lastPageFetched: 17,
		}
		await env.MCP_SESSIONS.put(progressKey('12345'), JSON.stringify(progress))

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Sync in progress: page 17 of 42, started 2026-08-22T07:23:00.000Z')
	})

	it('does not mention an in-flight sync when there is none', async () => {
		const text = await callCacheStats(buildServer())
		expect(text).not.toContain('Sync in progress')
	})
})

const HOUR = 3_600_000
const DAY = 24 * HOUR

async function putRecord(overrides: Partial<LastSyncRecord>): Promise<void> {
	const record: LastSyncRecord = {
		schemaVersion: 1,
		outcome: 'completed',
		trigger: 'scheduled',
		at: new Date(Date.now() - 2 * HOUR).toISOString(),
		pagesFetched: 1,
		consecutiveFailures: 0,
		lastHealthyAt: new Date(Date.now() - 2 * HOUR).toISOString(),
		...overrides,
	}
	await env.MCP_SESSIONS.put(lastOutcomeKey('12345'), JSON.stringify(record))
}

describe('get_cache_stats — last sync outcome', () => {
	beforeEach(async () => {
		for (const prefix of ['collection:', 'cache:']) {
			const list = await env.MCP_SESSIONS.list({ prefix })
			for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
		}
	})

	it('reports no record yet', async () => {
		const text = await callCacheStats(buildServer())
		expect(text).toContain('Last sync: none recorded yet')
	})

	it('reports a healthy skipped run', async () => {
		await putRecord({ outcome: 'skipped' })

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Last sync: skipped (no changes), scheduled, 2 h ago')
		expect(text).not.toContain('Failures in a row')
	})

	it('reports a failing streak with the last healthy run and the error', async () => {
		await putRecord({
			outcome: 'failed',
			consecutiveFailures: 9,
			lastHealthyAt: new Date(Date.now() - 14 * DAY).toISOString(),
			error: 'HTTP 500: boom',
		})

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Last sync: FAILED, scheduled, 2 h ago')
		expect(text).toContain('Failures in a row: 9; last healthy run 14 d ago')
		expect(text).toContain('Error: HTTP 500: boom')
		expect(text).not.toContain('throttling')
	})

	it('says when no healthy run was ever recorded', async () => {
		await putRecord({ outcome: 'failed', consecutiveFailures: 3, lastHealthyAt: null, error: 'HTTP 500: boom' })

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Failures in a row: 3; last healthy run not recorded yet')
	})

	it('adds the relay hint for a 429 failure', async () => {
		await putRecord({
			outcome: 'failed',
			consecutiveFailures: 1,
			error: 'Failed to search collection: HTTP 429: {"error":"Discogs rate-limit circuit tripped"}',
		})

		const text = await callCacheStats(buildServer())
		expect(text).toContain('route Discogs calls through your own IP')
	})

	it('omits the error line when a failure has no message', async () => {
		await putRecord({ outcome: 'crashed', consecutiveFailures: 1 })

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Last sync: CRASHED, scheduled, 2 h ago')
		expect(text).not.toContain('Error:')
	})

	it('treats an unreadable record as none', async () => {
		await env.MCP_SESSIONS.put(lastOutcomeKey('12345'), '{nope')

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Last sync: none recorded yet')
	})

	it('treats a record with an invalid run time as none', async () => {
		await putRecord({ at: 'not a date' })

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Last sync: none recorded yet')
		expect(text).not.toContain('NaN')
	})

	it('treats a record with an invalid last healthy time as none', async () => {
		await putRecord({ outcome: 'failed', consecutiveFailures: 2, lastHealthyAt: 'not a date' })

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Last sync: none recorded yet')
		expect(text).not.toContain('NaN')
	})

	it('labels a manual refresh', async () => {
		await putRecord({ trigger: 'manual' })

		const text = await callCacheStats(buildServer())
		expect(text).toContain('Last sync: completed, manual refresh, 2 h ago')
	})
})
