import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAuthenticatedTools } from '../../src/mcp/tools/authenticated'
import { snapshotKey, progressKey } from '../../src/sync/keys'
import type { ProgressBlob } from '../../src/sync/types'
import type { DiscogsCollectionItem } from '../../src/clients/discogs'

// Mirror scheduled.spec.ts: vi.mock DiscogsClient so tool calls don't hit
// the real rate-limiter DO or the network. The mocked searchCollection
// resolves a single canned page that satisfies syncCollection's pagination.
vi.mock('../../src/clients/discogs', async (orig) => {
	const actual = (await orig()) as object
	return {
		...actual,
		DiscogsClient: vi.fn().mockImplementation(() => ({
			searchCollection: vi.fn().mockResolvedValue({
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
			}),
			setRateLimiter: vi.fn(),
			// Other DiscogsClient methods (unused by the refresh tool path) get
			// stubbed lazily — register* may call setRateLimiter at construct time
			// but does not invoke any other method.
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

async function callRefresh(server: McpServer): Promise<{ status: string; count?: number; fetchedAt?: string; pagesFetched?: number }> {
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
			schemaVersion: 1,
			startedAt: new Date().toISOString(),
			totalPages: 1,
			totalCount: 1,
			lastPageFetched: 1,
			itemsSoFar: [item],
		}
		await env.MCP_SESSIONS.put(progressKey('12345'), JSON.stringify(progress))

		const server = buildServer()
		const result = await callRefresh(server)

		expect(result.status).toBe('resumed')
		expect(result.count).toBe(1)
		expect(result.pagesFetched).toBe(1)

		// Progress key was deleted on commit
		const remaining = await env.MCP_SESSIONS.get(progressKey('12345'))
		expect(remaining).toBeNull()
	})
})
