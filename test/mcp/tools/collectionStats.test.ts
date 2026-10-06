// ABOUTME: Tests the text get_collection_stats renders from a computed stats object.
// ABOUTME: Runs the registered handler against a stubbed DiscogsClient, with no KV cache bound.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerAuthenticatedTools } from '../../../src/mcp/tools/authenticated'
import { DiscogsClient, type DiscogsCollectionStats } from '../../../src/clients/discogs'
import type { SessionContext } from '../../../src/mcp/server'

type Handler = (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>

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

const sessionContext: SessionContext = {
	session: {
		userId: 'u1',
		username: 'listener',
		numericId: '1',
		accessToken: 't',
		accessTokenSecret: 's',
		iat: 0,
		exp: Number.MAX_SAFE_INTEGER,
	},
	connectionId: 'conn-1',
	baseUrl: 'https://discogs.example.net',
}

async function callCollectionStats(): Promise<string> {
	const handlers: Record<string, Handler> = {}
	const server = {
		tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => {
			handlers[name] = handler
		}),
		prompt: vi.fn(),
		resource: vi.fn(),
	} as any
	// No MCP_SESSIONS binding, so the handler takes the uncached DiscogsClient path.
	const env = { DISCOGS_CONSUMER_KEY: 'k', DISCOGS_CONSUMER_SECRET: 's' } as any
	registerAuthenticatedTools(server, env, async () => sessionContext)

	const res = await handlers['get_collection_stats']({}, {})
	return res.content.map((c) => c.text).join('\n')
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
