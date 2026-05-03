import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, createScheduledController, createExecutionContext } from 'cloudflare:test'
import worker from '../../src/index-oauth'
import { snapshotKey, tokenMirrorKey } from '../../src/sync/keys'

// The scheduled handler ultimately calls DiscogsClient.searchCollection, which
// routes through the rate-limiter Durable Object — its fetch runs in a separate
// isolate where globalThis.fetch stubbing has no effect. To keep the test
// hermetic, vi.mock DiscogsClient itself so the handler's `new DiscogsClient(...)`
// returns a fake whose searchCollection resolves with a canned page.
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
		})),
	}
})

describe('scheduled() handler', () => {
	beforeEach(async () => {
		const list = await env.MCP_SESSIONS.list()
		for (const k of list.keys) await env.MCP_SESSIONS.delete(k.name)
	})

	it('syncs every user in ALLOWED_DISCOGS_USER_ID who has a token mirror', async () => {
		for (const id of ['12345', '67890']) {
			await env.MCP_SESSIONS.put(
				tokenMirrorKey(id),
				JSON.stringify({
					numericId: id,
					username: `user${id}`,
					accessToken: 'tok',
					accessTokenSecret: 'sec',
				}),
			)
		}

		const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '0 * * * *' })
		const ctx = createExecutionContext()
		await worker.scheduled!(ctrl, { ...env, ALLOWED_DISCOGS_USER_ID: '12345,67890' } as any, ctx)

		expect(await env.MCP_SESSIONS.get(snapshotKey('12345'))).toBeTruthy()
		expect(await env.MCP_SESSIONS.get(snapshotKey('67890'))).toBeTruthy()
	})
})
