// ABOUTME: Tests that every Discogs call in the sign-in handshake goes through the rate limiter Durable Object when it is bound.
// ABOUTME: Runs the real DiscogsAuth behind each auth route, once with a recording RATE_LIMITER and once without the binding.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { DiscogsOAuthHandler } from '../../src/auth/oauth-handler'
import type { RateLimiterRequest, RateLimiterResponse } from '../../src/rate-limiter/types'

const REQUEST_TOKEN_URL = 'https://api.discogs.com/oauth/request_token'
const ACCESS_TOKEN_URL = 'https://api.discogs.com/oauth/access_token'
const IDENTITY_URL = 'https://api.discogs.com/oauth/identity'

/** What Discogs answers for each handshake endpoint. */
function discogsAnswer(url: string): RateLimiterResponse {
	switch (url) {
		case REQUEST_TOKEN_URL:
			return { status: 200, headers: {}, body: 'oauth_token=routed-request-token&oauth_token_secret=routed-request-secret' }
		case ACCESS_TOKEN_URL:
			return { status: 200, headers: {}, body: 'oauth_token=routed-access-token&oauth_token_secret=routed-access-secret' }
		case IDENTITY_URL:
			return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":8383,"username":"routeduser"}' }
		default:
			throw new Error(`Unexpected Discogs call: ${url}`)
	}
}

interface DiscogsCall {
	via: 'rate-limiter' | 'direct'
	method: string
	url: string
}

// Every Discogs call the handshake makes, in order, and which path it took.
let discogsCalls: DiscogsCall[] = []

const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input)
	discogsCalls.push({ via: 'direct', method: init?.method ?? 'GET', url })
	const answer = discogsAnswer(url)
	return new Response(answer.body, { status: answer.status, headers: answer.headers })
})
vi.stubGlobal('fetch', directFetch)

const limiterStub = {
	fetch: vi.fn(async (request: Request) => {
		const sent = (await request.json()) as RateLimiterRequest
		discogsCalls.push({ via: 'rate-limiter', method: sent.method, url: sent.url })
		return new Response(JSON.stringify(discogsAnswer(sent.url)), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}),
}
const rateLimiterNamespace = {
	idFromName: vi.fn((name: string) => ({ name })),
	get: vi.fn(() => limiterStub),
}

const completeAuthorization = vi.fn(async () => ({ redirectTo: 'https://client.example.com/callback?code=routed' }))

/** The handler's env, with or without the RATE_LIMITER binding. */
function handlerEnv(bound: boolean) {
	return {
		...env,
		DISCOGS_CONSUMER_KEY: 'routing-consumer-key',
		DISCOGS_CONSUMER_SECRET: 'routing-consumer-secret',
		ALLOWED_DISCOGS_USER_ID: '',
		RATE_LIMITER: bound ? rateLimiterNamespace : undefined,
		OAUTH_PROVIDER: {
			parseAuthRequest: vi.fn(async () => ({ clientId: 'routing-client', redirectUri: 'https://client.example.com/callback', scope: [] })),
			completeAuthorization,
		},
	}
}

async function call(request: Request, bound: boolean): Promise<Response> {
	const ctx = createExecutionContext()
	const res = await DiscogsOAuthHandler.fetch(request, handlerEnv(bound) as any, ctx)
	await waitOnExecutionContext(ctx)
	return res
}

describe.each([
	['bound', true, 'rate-limiter'],
	['not bound', false, 'direct'],
] as const)('sign-in handshake when RATE_LIMITER is %s', (_label, bound, via) => {
	beforeEach(() => {
		discogsCalls = []
		vi.clearAllMocks()
	})

	it(`/authorize gets the request token ${bound ? 'through the rate limiter' : 'directly'}`, async () => {
		const url = new URL('https://example.com/authorize')
		url.searchParams.set('client_id', 'routing-client')
		url.searchParams.set('redirect_uri', 'https://client.example.com/callback')
		url.searchParams.set('response_type', 'code')

		const res = await call(new Request(url.toString()), bound)

		expect(res.status).toBe(302)
		expect(res.headers.get('Location')).toBe('https://www.discogs.com/oauth/authorize?oauth_token=routed-request-token')
		expect(discogsCalls).toEqual([{ via, method: 'GET', url: REQUEST_TOKEN_URL }])
	})

	it(`/discogs-callback exchanges the token and reads the identity ${bound ? 'through the rate limiter' : 'directly'}`, async () => {
		await env.MCP_SESSIONS.put(
			'oauth-pending:routed-request-token',
			JSON.stringify({
				oauthReqInfo: { clientId: 'routing-client', redirectUri: 'https://client.example.com/callback', scope: [] },
				requestTokenSecret: 'routed-request-secret',
			}),
		)

		const res = await call(new Request('https://example.com/discogs-callback?oauth_token=routed-request-token&oauth_verifier=v'), bound)

		expect(res.status).toBe(302)
		expect(discogsCalls).toEqual([
			{ via, method: 'POST', url: ACCESS_TOKEN_URL },
			{ via, method: 'GET', url: IDENTITY_URL },
		])
		expect(completeAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'routeduser',
				props: {
					numericId: '8383',
					username: 'routeduser',
					accessToken: 'routed-access-token',
					accessTokenSecret: 'routed-access-secret',
				},
			}),
		)
	})

	it(`/login gets the request token ${bound ? 'through the rate limiter' : 'directly'}`, async () => {
		const res = await call(new Request('https://example.com/login?session_id=routing-session'), bound)

		expect(res.status).toBe(302)
		expect(res.headers.get('Location')).toBe('https://www.discogs.com/oauth/authorize?oauth_token=routed-request-token')
		expect(discogsCalls).toEqual([{ via, method: 'GET', url: REQUEST_TOKEN_URL }])
	})

	it(`/callback exchanges the token and reads the identity ${bound ? 'through the rate limiter' : 'directly'}`, async () => {
		await env.MCP_SESSIONS.put(
			'login-pending:routing-session',
			JSON.stringify({
				sessionId: 'routing-session',
				csrfToken: 'routing-csrf',
				requestToken: 'routed-request-token',
				requestTokenSecret: 'routed-request-secret',
				fromMcpClient: true,
				timestamp: Date.now(),
			}),
		)

		const res = await call(
			new Request('https://example.com/callback?session_id=routing-session&oauth_token=routed-request-token&oauth_verifier=v', {
				headers: { Cookie: '__Host-csrf=routing-csrf' },
			}),
			bound,
		)

		expect(res.status).toBe(200)
		expect(await res.text()).toContain('routeduser')
		expect(discogsCalls).toEqual([
			{ via, method: 'POST', url: ACCESS_TOKEN_URL },
			{ via, method: 'GET', url: IDENTITY_URL },
		])
	})

	if (bound) {
		it('uses the same Durable Object instance as the rest of the Worker', async () => {
			await call(new Request('https://example.com/login?session_id=routing-instance'), bound)

			expect(rateLimiterNamespace.idFromName).toHaveBeenCalledWith('discogs-rate-limiter')
			expect(directFetch).not.toHaveBeenCalled()
		})
	}
})
