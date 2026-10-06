// ABOUTME: Tests the text get_collection_stats renders from a computed stats object.
// ABOUTME: Calls the tool through an MCP client against a stubbed DiscogsClient, with no KV cache bound.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../../src/mcp/server'
import { DiscogsClient, type DiscogsCollectionStats } from '../../../src/clients/discogs'

const stats: DiscogsCollectionStats = {
	totalReleases: 900,
	totalValue: 0,
	genreBreakdown: { Rock: 500, Jazz: 400 },
	decadeBreakdown: { '2010s': 450, '2020s': 446, '1970s': 4 },
	formatBreakdown: { CD: 900 },
	labelBreakdown: {},
	averageRating: 4.2,
	ratedReleases: 10,
}

async function callCollectionStats(): Promise<string> {
	// No MCP_SESSIONS binding, so the handler takes the uncached DiscogsClient path.
	const env = { DISCOGS_CONSUMER_KEY: 'k', DISCOGS_CONSUMER_SECRET: 's' } as any
	const { server, setContext } = createMcpServer(env, 'https://discogs.example.net')
	setContext({
		session: { username: 'listener', numericId: '1', accessToken: 't', accessTokenSecret: 's' },
		sessionId: 'conn-1',
	})
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'collection-stats-test', version: '0.0.0' })
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

	const res = await client.callTool({ name: 'get_collection_stats', arguments: {} })
	return (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n')
}

describe('get_collection_stats', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('prints each decade label once, without a doubled "s"', async () => {
		vi.spyOn(DiscogsClient.prototype, 'getCollectionStats').mockResolvedValue(stats)

		const text = await callCollectionStats()

		expect(text).toContain('• 2010s: 450 releases')
		expect(text).toContain('• 2020s: 446 releases')
		expect(text).not.toContain('0ss')
	})
})
