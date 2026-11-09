import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { McpServer } from '@modelcontextprotocol/server'
import { registerAuthenticatedTools } from '../../src/mcp/tools/authenticated'
import { snapshotKey, progressKey, pageKey } from '../../src/sync/keys'
import { readLastSyncRecord } from '../../src/sync/lastOutcome'
import { toSnapshotItem, type ProgressBlob } from '../../src/sync/types'
import type { DiscogsCollectionItem } from '../../src/clients/discogs'

// Mirror scheduled.spec.ts: vi.mock DiscogsClient so tool calls don't hit
// the real rate-limiter DO or the network. `searchCollection` is a hoisted
// handle so each test can decide what the Discogs client returns; by default
// it resolves a single canned page that satisfies syncCollection's pagination.
const { searchCollection } = vi.hoisted(() => ({ searchCollection: vi.fn() }))

const cannedPage = {
	pagination: { pages: 1, page: 1, per_page: 100, items: 1, urls: {} },
	releases: [
		{
			id: 1,
			instance_id: 101,
			folder_id: 0,
			date_added: '2026-01-01T00:00:00Z',
			rating: 0,
			basic_information: {
				id: 1,
				title: 't',
				year: 2020,
				resource_url: '',
				thumb: '',
				cover_image: '',
				formats: [],
				labels: [],
				artists: [],
				genres: [],
				styles: [],
			},
		},
	],
}

vi.mock('../../src/clients/discogs', async (orig) => {
	const actual = (await orig()) as object
	return {
		...actual,
		DiscogsClient: vi.fn().mockImplementation(function () {
			return {
				searchCollection,
				setRateLimiter: vi.fn(),
				// Other DiscogsClient methods (unused by the refresh tool path) get
				// stubbed lazily — register* may call setRateLimiter at construct time
				// but does not invoke any other method.
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

function buildServer(kv: KVNamespace = env.MCP_SESSIONS) {
	const server = new McpServer({ name: 'test', version: '0.0.0' })
	registerAuthenticatedTools(server, { ...env, MCP_SESSIONS: kv } as any, async () => fakeSession() as any)
	return server
}

/** A KV namespace that delegates to `inner` but rejects a `put` to one key. */
function kvFailingPutOn(inner: KVNamespace, failingKey: string): KVNamespace {
	return {
		get: inner.get.bind(inner),
		list: inner.list.bind(inner),
		delete: inner.delete.bind(inner),
		getWithMetadata: inner.getWithMetadata.bind(inner),
		put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
			if (key === failingKey) throw new Error(`KV put failed for ${key}`)
			return inner.put(key, value, options)
		},
	} as unknown as KVNamespace
}

async function callRefresh(server: McpServer): Promise<{
	status: string
	count?: number
	fetchedAt?: string
	pagesFetched?: number
	error?: string
	syncedThroughPage?: number
	totalPages?: number
}> {
	// The MCP SDK stores registrations on the server instance; reach in and call
	// the callback directly. This mirrors how the MCP server eventually invokes
	// it for a tools/call request, without standing up the full transport.
	const tools = (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
			>
		}
	)._registeredTools
	const tool = tools['refresh_collection']
	if (!tool) throw new Error('refresh_collection tool not registered')
	const res = await tool.handler({}, {})
	return JSON.parse(res.content[0].text)
}

describe('refresh_collection tool', () => {
	beforeEach(async () => {
		searchCollection.mockReset()
		searchCollection.mockResolvedValue(cannedPage)
		const list = await env.MCP_SESSIONS.list({ prefix: 'collection:' })
		for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
	})

	it('forces a full sync and returns status: completed', async () => {
		const server = buildServer()
		const result = await callRefresh(server)

		expect(result.status).toBe('completed')
		expect(result.count).toBe(1)
		expect(result.pagesFetched).toBe(1)
		expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

		const snap = await env.MCP_SESSIONS.get(snapshotKey('12345'))
		expect(snap).toBeTruthy()
	})

	it('returns status: resumed when a fresh progress key exists', async () => {
		// Pre-populate progress with lastPageFetched === totalPages so the
		// resumed branch runs zero loop iterations and just commits the snapshot.
		const item: DiscogsCollectionItem = {
			id: 99,
			instance_id: 9901,
			folder_id: 0,
			date_added: '2026-01-01T00:00:00Z',
			rating: 0,
			basic_information: {
				id: 99,
				title: 'pre',
				year: 2020,
				resource_url: '',
				thumb: '',
				cover_image: '',
				formats: [],
				labels: [],
				artists: [],
				genres: [],
				styles: [],
			},
		}
		const progress: ProgressBlob = {
			schemaVersion: 2,
			startedAt: new Date().toISOString(),
			totalPages: 1,
			totalCount: 1,
			lastPageFetched: 1,
		}
		await env.MCP_SESSIONS.put(progressKey('12345'), JSON.stringify(progress))
		await env.MCP_SESSIONS.put(pageKey('12345', 1), JSON.stringify([toSnapshotItem(item)]))

		const server = buildServer()
		const result = await callRefresh(server)

		expect(result.status).toBe('resumed')
		expect(result.count).toBe(1)
		// The resume had nothing left to fetch, so this run made no Discogs calls.
		expect(result.pagesFetched).toBe(0)

		// Progress key was deleted on commit
		const remaining = await env.MCP_SESSIONS.get(progressKey('12345'))
		expect(remaining).toBeNull()
	})

	it('surfaces the sync error when every page fetch fails', async () => {
		// What the rate limiter's fast-fail looks like by the time it reaches the
		// sync: DiscogsClient wraps the 429 body, which carries retryAfterSecs.
		// Dropping it left a throttled sync indistinguishable from a dead one.
		const tripped = 'Failed to search collection: HTTP 429: {"error":"Discogs rate-limit circuit tripped","retryAfterSecs":534}'
		searchCollection.mockRejectedValue(new Error(tripped))

		const server = buildServer()
		const result = await callRefresh(server)

		expect(result.status).toBe('failed')
		expect(result.pagesFetched).toBe(0)
		expect(result.error).toBe(tripped)
	}, 15_000)

	it('omits error on a successful sync', async () => {
		const server = buildServer()
		const result = await callRefresh(server)

		expect(result.status).toBe('completed')
		expect(result).not.toHaveProperty('error')
	})

	it('records a manual outcome', async () => {
		await callRefresh(buildServer())

		expect(await readLastSyncRecord(env.MCP_SESSIONS, '12345')).toMatchObject({ outcome: 'completed', trigger: 'manual' })
	})

	it('includes syncedThroughPage and totalPages when the sync reports them', async () => {
		const progress: ProgressBlob = {
			schemaVersion: 2,
			startedAt: new Date().toISOString(),
			totalPages: 3,
			totalCount: 3,
			lastPageFetched: 1,
		}
		await env.MCP_SESSIONS.put(progressKey('12345'), JSON.stringify(progress))
		await env.MCP_SESSIONS.put(pageKey('12345', 1), JSON.stringify([toSnapshotItem(cannedPage.releases[0] as DiscogsCollectionItem)]))
		searchCollection.mockRejectedValue(new Error('Failed to search collection: HTTP 429: throttled'))

		const result = await callRefresh(buildServer())

		expect(result.status).toBe('failed')
		expect(result.syncedThroughPage).toBe(1)
		expect(result.totalPages).toBe(3)
	}, 15_000)

	it('records crashed and keeps throwing when the sync throws', async () => {
		const server = buildServer(kvFailingPutOn(env.MCP_SESSIONS, snapshotKey('12345')))

		await expect(callRefresh(server)).rejects.toThrow(`KV put failed for ${snapshotKey('12345')}`)
		expect(await readLastSyncRecord(env.MCP_SESSIONS, '12345')).toMatchObject({
			outcome: 'crashed',
			trigger: 'manual',
			error: `KV put failed for ${snapshotKey('12345')}`,
		})
	})
})
