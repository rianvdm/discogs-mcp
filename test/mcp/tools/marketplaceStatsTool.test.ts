// ABOUTME: Tests the get_marketplace_stats tool: one line per release, partial failures, and duplicate IDs.
// ABOUTME: DiscogsClient is mocked so calls never reach the rate limiter or the network.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { McpServer } from '@modelcontextprotocol/server'
import { registerAuthenticatedTools } from '../../../src/mcp/tools/authenticated'
import type { DiscogsMarketplaceStats } from '../../../src/clients/discogs'

const { getMarketplaceStats } = vi.hoisted(() => ({ getMarketplaceStats: vi.fn() }))

vi.mock('../../../src/clients/discogs', async (orig) => {
	const actual = (await orig()) as object
	return {
		...actual,
		DiscogsClient: vi.fn().mockImplementation(function () {
			return { getMarketplaceStats, setRateLimiter: vi.fn() }
		}),
	}
})

const session = {
	session: { userId: '1', username: 'mathieu', numericId: '1', accessToken: 'tok', accessTokenSecret: 'sec', iat: 0, exp: 0 },
	connectionId: 'conn-1',
}

type Handler = (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>

async function callTool(args: unknown): Promise<string> {
	const server = new McpServer({ name: 'test', version: '0.0.0' })
	registerAuthenticatedTools(server, env as any, async () => session as any)
	const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools
	const tool = tools['get_marketplace_stats']
	if (!tool) throw new Error('get_marketplace_stats tool not registered')
	const res = await tool.handler(args, {})
	return res.content.map((c) => c.text).join('\n')
}

const statsById: Record<number, DiscogsMarketplaceStats> = {
	101: { num_for_sale: 3, lowest_price: { currency: 'EUR', value: 42.5 }, blocked_from_sale: false },
	// Shape Discogs returns for a release with nothing listed
	202: { num_for_sale: 0, lowest_price: null, blocked_from_sale: false },
	303: { num_for_sale: null, lowest_price: null, blocked_from_sale: true },
}

describe('get_marketplace_stats tool', () => {
	beforeEach(async () => {
		getMarketplaceStats.mockReset()
		getMarketplaceStats.mockImplementation(async (id: number) => {
			const stats = statsById[id]
			if (!stats) throw new Error(`Failed to fetch marketplace stats for release ${id}: HTTP 404: Release not found.`)
			return stats
		})
		const list = await env.MCP_SESSIONS.list({ prefix: 'cache:marketplace:' })
		for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
	})

	it('reports copies and lowest price, nothing listed, and blocked releases each on their own line', async () => {
		const text = await callTool({ release_ids: [101, 202, 303] })

		expect(text).toContain('- release 101: 3 for sale, lowest 42.50 EUR')
		expect(text).toContain('- release 202: none for sale')
		expect(text).toContain('- release 303: blocked from sale on Discogs')
	})

	it('passes the requested currency through to Discogs', async () => {
		await callTool({ release_ids: [101], currency: 'GBP' })

		expect(getMarketplaceStats).toHaveBeenCalledWith(101, 'tok', 'sec', env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET, 'GBP')
	})

	it('still reports the other releases when one lookup fails', async () => {
		const text = await callTool({ release_ids: [101, 999, 202] })

		expect(text).toContain('- release 101: 3 for sale, lowest 42.50 EUR')
		expect(text).toContain(
			'- release 999: could not check (Failed to fetch marketplace stats for release 999: HTTP 404: Release not found.)',
		)
		expect(text).toContain('- release 202: none for sale')
	})

	it('checks a release listed twice only once', async () => {
		const text = await callTool({ release_ids: [101, 101] })

		expect(getMarketplaceStats).toHaveBeenCalledTimes(1)
		expect(text.match(/- release 101:/g)).toHaveLength(1)
	})
})
