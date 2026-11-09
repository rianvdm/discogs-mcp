// ABOUTME: Tests the wantlist tools: registration, notes and ratings in get_wantlist output, and its filters.
// ABOUTME: DiscogsClient is mocked so calls never reach the rate limiter or the network.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { McpServer } from '@modelcontextprotocol/server'
import { registerAuthenticatedTools } from '../../../src/mcp/tools/authenticated'
import type { DiscogsWant } from '../../../src/clients/discogs'

const { getWantlist } = vi.hoisted(() => ({ getWantlist: vi.fn() }))

vi.mock('../../../src/clients/discogs', async (orig) => {
	const actual = (await orig()) as object
	return {
		...actual,
		DiscogsClient: vi.fn().mockImplementation(function () {
			return { getWantlist, setRateLimiter: vi.fn() }
		}),
	}
})

describe('wantlist tool registration', () => {
	it('registers get_wantlist, add_to_wantlist, and remove_from_wantlist', () => {
		const registered: string[] = []
		const server = {
			registerTool: vi.fn((name: string) => {
				registered.push(name)
			}),
			registerPrompt: vi.fn(),
			registerResource: vi.fn(),
		} as any
		const env = { DISCOGS_CONSUMER_KEY: 'k', DISCOGS_CONSUMER_SECRET: 's' } as any
		const getSessionContext = async () => ({ session: null, connectionId: undefined }) as any

		registerAuthenticatedTools(server, env, getSessionContext)

		expect(registered).toContain('get_wantlist')
		expect(registered).toContain('add_to_wantlist')
		expect(registered).toContain('remove_from_wantlist')
	})
})

const session = {
	session: { userId: '1', username: 'mathieu', numericId: '1', accessToken: 'tok', accessTokenSecret: 'sec', iat: 0, exp: 0 },
	connectionId: 'conn-1',
}

type Handler = (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>

async function callGetWantlist(args: Record<string, unknown>): Promise<string> {
	const server = new McpServer({ name: 'test', version: '0.0.0' })
	registerAuthenticatedTools(server, env as any, async () => session as any)
	const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools
	// Defaults the input schema would apply on a real tools/call
	const res = await tools['get_wantlist'].handler({ page: 1, per_page: 50, ...args }, {})
	return res.content.map((c) => c.text).join('\n')
}

function want(id: number, title: string, extra: { rating?: number; notes?: string } = {}): DiscogsWant {
	return {
		id,
		rating: extra.rating ?? 0,
		notes: extra.notes,
		date_added: '2026-01-01',
		resource_url: '',
		basic_information: {
			id,
			title,
			year: 1972,
			resource_url: '',
			thumb: '',
			cover_image: '',
			formats: [],
			labels: [],
			artists: [{ name: 'Some Artist', id: 1 }],
			genres: [],
			styles: [],
		},
	} as DiscogsWant
}

/** Serves `wants` from the mocked Discogs client in pages of the requested size. */
function serveWantlist(wants: DiscogsWant[], totalItems = wants.length) {
	getWantlist.mockImplementation(async (_u: string, _t: string, _s: string, opts: { page?: number; per_page?: number }) => {
		const page = opts.page ?? 1
		const perPage = opts.per_page ?? 50
		return {
			pagination: { page, pages: Math.max(1, Math.ceil(totalItems / perPage)), per_page: perPage, items: totalItems, urls: {} },
			wants: wants.slice((page - 1) * perPage, page * perPage),
		}
	})
}

describe('get_wantlist output and filters', () => {
	beforeEach(async () => {
		getWantlist.mockReset()
		const list = await env.MCP_SESSIONS.list({ prefix: 'cache:wantlists:' })
		for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
	})

	it("shows a want's rating and notes when they are set, and nothing extra when they are not", async () => {
		serveWantlist([want(1, 'Plain'), want(2, 'Tagged', { rating: 4, notes: 'watch\nunder 40' })])

		const text = await callGetWantlist({})

		expect(text).toContain('- Some Artist — Plain (1972) [release 1]\n')
		expect(text).toContain('- Some Artist — Tagged (1972) [release 2] — rating 4/5 — notes: "watch under 40"')
	})

	it('returns only wants whose notes contain the text, ignoring case, from every page of the wantlist', async () => {
		const wants = Array.from({ length: 250 }, (_, i) => want(i + 1, `Album ${i + 1}`))
		wants[4] = want(5, 'Early pick', { notes: 'WATCH this' })
		wants[230] = want(231, 'Late pick', { notes: 'keep a watch' })
		serveWantlist(wants)

		const text = await callGetWantlist({ notes_contains: 'watch' })

		expect(text).toContain('[release 5]')
		expect(text).toContain('[release 231]')
		expect(text).not.toContain('[release 6]')
		expect(text).toContain('2 of 250')
		expect(getWantlist.mock.calls.map((c) => c[3])).toEqual([
			{ page: 1, per_page: 100 },
			{ page: 2, per_page: 100 },
			{ page: 3, per_page: 100 },
		])
	})

	it('returns only wants rated at least min_rating', async () => {
		serveWantlist([want(1, 'Unrated'), want(2, 'Three', { rating: 3 }), want(3, 'Five', { rating: 5 })])

		const text = await callGetWantlist({ min_rating: 4 })

		expect(text).toContain('[release 3]')
		expect(text).not.toContain('[release 1]')
		expect(text).not.toContain('[release 2]')
	})

	it('requires a want to pass both filters when both are given', async () => {
		serveWantlist([
			want(1, 'Noted only', { notes: 'watch' }),
			want(2, 'Rated only', { rating: 5 }),
			want(3, 'Both', { rating: 5, notes: 'watch' }),
		])

		const text = await callGetWantlist({ notes_contains: 'watch', min_rating: 5 })

		expect(text).toContain('[release 3]')
		expect(text).not.toContain('[release 1]')
		expect(text).not.toContain('[release 2]')
	})

	it('stops after 50 pages and says how much of the wantlist it searched', async () => {
		const wants = Array.from({ length: 5100 }, (_, i) => want(i + 1, `Album ${i + 1}`, { notes: 'watch' }))
		serveWantlist(wants)

		const text = await callGetWantlist({ notes_contains: 'nothing matches this' })

		expect(getWantlist).toHaveBeenCalledTimes(50)
		expect(text).toContain('searched the first 5000 of 5100')
	})
})
