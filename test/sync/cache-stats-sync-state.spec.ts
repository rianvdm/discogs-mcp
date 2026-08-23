import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAuthenticatedTools } from '../../src/mcp/tools/authenticated'
import { snapshotKey, progressKey } from '../../src/sync/keys'
import type { ProgressBlob, SnapshotBlob } from '../../src/sync/types'

// Keep tool registration off the network and the rate-limiter DO.
vi.mock('../../src/clients/discogs', async (orig) => {
	const actual = (await orig()) as object
	return {
		...actual,
		DiscogsClient: vi.fn().mockImplementation(() => ({
			setRateLimiter: vi.fn(),
		})),
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
