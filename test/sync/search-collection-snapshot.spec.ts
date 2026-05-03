import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAuthenticatedTools } from '../../src/mcp/tools/authenticated'
import { snapshotKey } from '../../src/sync/keys'
import type { SnapshotBlob } from '../../src/sync/types'
import type { DiscogsCollectionItem } from '../../src/clients/discogs'

// vi.mock is hoisted — keep the canned mock at module scope. Tests can
// reach into the mock via vi.mocked(...) to assert call counts.
const searchCollectionMock = vi.fn()
const getUserProfileMock = vi.fn()

vi.mock('../../src/clients/discogs', async (orig) => {
	const actual = (await orig()) as object
	return {
		...actual,
		DiscogsClient: vi.fn().mockImplementation(() => ({
			searchCollection: searchCollectionMock,
			getUserProfile: getUserProfileMock,
			setRateLimiter: vi.fn(),
		})),
	}
})

const fakeSession = () => ({
	session: {
		userId: '12345',
		username: 'someuser',
		numericId: '12345',
		accessToken: 'tok',
		accessTokenSecret: 'sec',
		iat: 0,
		exp: 0,
	},
	connectionId: 'conn-1',
})

function buildItem(id: number, title: string): DiscogsCollectionItem {
	return {
		id,
		instance_id: id * 100,
		folder_id: 0,
		date_added: '2026-01-01T00:00:00Z',
		rating: 0,
		basic_information: {
			id,
			title,
			year: 2020,
			resource_url: '',
			thumb: '',
			cover_image: '',
			formats: [],
			labels: [],
			artists: [{ id: 1, name: 'Some Artist', resource_url: '', anv: '', join: '', role: '', tracks: '' }],
			genres: [],
			styles: [],
		},
	}
}

function buildServer() {
	const server = new McpServer({ name: 'test', version: '0.0.0' })
	registerAuthenticatedTools(server, env as any, async () => fakeSession() as any)
	return server
}

async function callSearch(server: McpServer, query: string): Promise<string> {
	const tools = (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
			>
		}
	)._registeredTools
	const tool = tools['search_collection']
	if (!tool) throw new Error('search_collection tool not registered')
	const res = await tool.handler({ query, per_page: 50, page: 1, group_pressings: false }, {})
	return res.content[0].text
}

describe('search_collection snapshot fast path', () => {
	beforeEach(async () => {
		searchCollectionMock.mockReset()
		getUserProfileMock.mockReset()
		getUserProfileMock.mockResolvedValue({ username: 'someuser', id: 12345 })

		const list = await env.MCP_SESSIONS.list({ prefix: 'collection:' })
		for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
		// Also clear any cached collection from prior tests
		const cacheList = await env.MCP_SESSIONS.list({ prefix: 'collections:' })
		for (const k of cacheList.keys) await env.MCP_SESSIONS.delete(k.name)
	})

	it('uses snapshot when present and skips live pagination', async () => {
		const snapshot: SnapshotBlob = {
			schemaVersion: 1,
			fetchedAt: new Date().toISOString(),
			count: 1,
			topPageInstanceIds: [100],
			items: [buildItem(1, 'Snapshot Album')],
		}
		await env.MCP_SESSIONS.put(snapshotKey('12345'), JSON.stringify(snapshot))

		const server = buildServer()
		const text = await callSearch(server, 'snapshot')

		expect(text).toContain('Snapshot Album')
		expect(searchCollectionMock).not.toHaveBeenCalled()
	})

	it('falls back to live pagination when no snapshot exists', async () => {
		searchCollectionMock.mockResolvedValue({
			pagination: { pages: 1, page: 1, per_page: 100, items: 1, urls: {} },
			releases: [buildItem(2, 'Live Album')],
		})

		const server = buildServer()
		await callSearch(server, 'live')

		expect(searchCollectionMock).toHaveBeenCalled()
	})
})
