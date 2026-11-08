// ABOUTME: Regression test for signing in through both hostnames the Worker serves, in either order, within one isolate.
// ABOUTME: Guards against one origin's OAuth helpers on the shared env serving the other origin's /authorize (issue #81).
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index-oauth'

vi.mock('../src/auth/discogs', () => ({
	DiscogsAuth: vi.fn().mockImplementation(function () {
		return {
			getRequestToken: vi.fn().mockResolvedValue({
				oauth_token: 'cross-origin-request-token',
				oauth_token_secret: 'cross-origin-request-secret',
				oauth_callback_confirmed: 'true',
			}),
			getAccessToken: vi.fn().mockResolvedValue({
				oauth_token: 'cross-origin-access-token',
				oauth_token_secret: 'cross-origin-access-secret',
			}),
			getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'OAuth mock-auth' }),
			getIdentity: vi.fn().mockResolvedValue({ id: 42, username: 'discogsuser' }),
			setRateLimiter: vi.fn(),
		}
	}),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const CUSTOM_DOMAIN = 'https://discogs-mcp.com'
const WORKERS_DEV = 'https://discogs-mcp-prod.rian-db8.workers.dev'
const REDIRECT_URI = 'https://client.example.com/callback'
const VERIFIER = 'cross-origin-verifier-0123456789abcdefghijklmnopqrstuvwxyz'

async function call(request: Request): Promise<Response> {
	const ctx = createExecutionContext()
	const res = await worker.fetch(request, env as any, ctx)
	await waitOnExecutionContext(ctx)
	return res
}

async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '')
}

async function registerClient(origin: string): Promise<string> {
	const res = await call(
		new Request(`${origin}/oauth/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_name: 'cross-origin',
				redirect_uris: [REDIRECT_URI],
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
			}),
		}),
	)
	expect(res.status).toBe(201)
	return ((await res.json()) as { client_id: string }).client_id
}

/**
 * Signs in on one origin the way an MCP client does: register, /authorize with
 * `resource` set to that origin, the Discogs callback, then the code exchange and
 * an MCP call with the issued token.
 */
async function signIn(origin: string): Promise<void> {
	const clientId = await registerClient(origin)

	const url = new URL(`${origin}/authorize`)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', clientId)
	url.searchParams.set('redirect_uri', REDIRECT_URI)
	url.searchParams.set('state', 'cross-origin-state')
	url.searchParams.set('code_challenge', await s256(VERIFIER))
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('resource', origin)

	const authRes = await call(new Request(url.toString()))
	expect(authRes.status, `${origin}/authorize: ${await authRes.clone().text()}`).toBe(302)
	expect(authRes.headers.get('Location')).toContain('discogs.com/oauth/authorize')

	const cbRes = await call(new Request(`${origin}/discogs-callback?oauth_token=cross-origin-request-token&oauth_verifier=v`))
	expect(cbRes.status).toBe(302)
	const location = new URL(cbRes.headers.get('Location') ?? '')
	expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI)
	const code = location.searchParams.get('code')
	expect(code).toBeTruthy()

	const tokenRes = await call(
		new Request(`${origin}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code: code as string,
				redirect_uri: REDIRECT_URI,
				client_id: clientId,
				code_verifier: VERIFIER,
				resource: origin,
			}).toString(),
		}),
	)
	expect(tokenRes.status, `${origin}/oauth/token: ${await tokenRes.clone().text()}`).toBe(200)
	const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }

	const mcpRes = await call(
		new Request(`${origin}/mcp`, {
			method: 'POST',
			// The MCP handler validates the Host header on workers.dev hostnames.
			headers: {
				Host: new URL(origin).host,
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cross-origin', version: '1.0' } },
				id: 1,
			}),
		}),
	)
	expect(mcpRes.status, `${origin}/mcp: ${await mcpRes.clone().text()}`).toBe(200)
}

describe('OAuth sign-in on both hostnames in one isolate', () => {
	beforeEach(() => {
		mockFetch.mockReset()
		// `env` is shared across this file the way it is across an isolate's requests. Clear any provider
		// helpers a previous test left on it, so each order starts the way a fresh isolate would.
		Reflect.deleteProperty(env, 'OAUTH_PROVIDER')
	})

	it('signs in on the custom domain, then on workers.dev', async () => {
		await signIn(CUSTOM_DOMAIN)
		await signIn(WORKERS_DEV)
	})

	it('signs in on workers.dev, then on the custom domain', async () => {
		await signIn(WORKERS_DEV)
		await signIn(CUSTOM_DOMAIN)
	})
})
