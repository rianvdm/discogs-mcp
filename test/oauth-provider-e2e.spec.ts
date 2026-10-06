// ABOUTME: End-to-end MCP OAuth test with no mocked provider: register → authorize → Discogs callback → token → /mcp → refresh.
// ABOUTME: Runs once per `resource` shape a client can send, since tokens are bound to the bare-origin resource.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index-oauth'

vi.mock('../src/auth/discogs', () => ({
	DiscogsAuth: vi.fn().mockImplementation(function () {
		return {
			getRequestToken: vi.fn().mockResolvedValue({
				oauth_token: 'e2e-request-token',
				oauth_token_secret: 'e2e-request-secret',
				oauth_callback_confirmed: 'true',
			}),
			getAccessToken: vi.fn().mockResolvedValue({
				oauth_token: 'e2e-access-token',
				oauth_token_secret: 'e2e-access-secret',
			}),
			getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'OAuth mock-auth' }),
		}
	}),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const ORIGIN = 'https://discogs-mcp.example.com'
const REDIRECT_URI = 'https://client.example.com/callback'
const VERIFIER = 'e2e-verifier-0123456789abcdefghijklmnopqrstuvwxyz'
const MCP_INIT = JSON.stringify({
	jsonrpc: '2.0',
	method: 'initialize',
	params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } },
	id: 1,
})
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

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

function form(params: Record<string, string | undefined>): Request {
	const body = new URLSearchParams()
	for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v)
	return new Request(`${ORIGIN}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString(),
	})
}

async function registerClient(): Promise<string> {
	const res = await call(
		new Request(`${ORIGIN}/oauth/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_name: 'e2e',
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

/** Runs /authorize and the Discogs callback; returns the authorization code. */
async function authorize(clientId: string, resource: string | undefined): Promise<string> {
	const url = new URL(`${ORIGIN}/authorize`)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', clientId)
	url.searchParams.set('redirect_uri', REDIRECT_URI)
	url.searchParams.set('state', 'e2e-state')
	url.searchParams.set('code_challenge', await s256(VERIFIER))
	url.searchParams.set('code_challenge_method', 'S256')
	if (resource !== undefined) url.searchParams.set('resource', resource)

	const authRes = await call(new Request(url.toString()))
	expect(authRes.status, await authRes.clone().text()).toBe(302)
	expect(authRes.headers.get('Location')).toContain('discogs.com/oauth/authorize')

	mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, username: 'discogsuser' }), { status: 200 }))
	const cbRes = await call(new Request(`${ORIGIN}/discogs-callback?oauth_token=e2e-request-token&oauth_verifier=v`))
	expect(cbRes.status).toBe(302)
	const location = new URL(cbRes.headers.get('Location') ?? '')
	expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI)
	const code = location.searchParams.get('code')
	expect(code).toBeTruthy()
	return code as string
}

async function mcpInit(accessToken: string): Promise<Response> {
	return call(
		new Request(`${ORIGIN}/mcp`, {
			method: 'POST',
			body: MCP_INIT,
			headers: { ...MCP_HEADERS, Authorization: `Bearer ${accessToken}` },
		}),
	)
}

// What a client may send as `resource`: nothing, the advertised origin, the origin
// with a trailing slash (what most stored grants carry), or the MCP endpoint URL.
const RESOURCE_SHAPES: Array<[string, string | undefined]> = [
	['no resource', undefined],
	['the bare origin', ORIGIN],
	['the origin with a trailing slash', `${ORIGIN}/`],
	['the /mcp endpoint URL', `${ORIGIN}/mcp`],
]

describe('MCP OAuth end to end, with the real provider', () => {
	beforeEach(() => {
		mockFetch.mockReset()
	})

	it('advertises the bare origin as the protected resource', async () => {
		const res = await call(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`))
		expect(res.status).toBe(200)
		expect(((await res.json()) as { resource: string }).resource).toBe(ORIGIN)
	})

	it('refuses a resource on another server at /authorize', async () => {
		const clientId = await registerClient()
		const url = new URL(`${ORIGIN}/authorize`)
		url.searchParams.set('response_type', 'code')
		url.searchParams.set('client_id', clientId)
		url.searchParams.set('redirect_uri', REDIRECT_URI)
		url.searchParams.set('code_challenge', await s256(VERIFIER))
		url.searchParams.set('code_challenge_method', 'S256')
		url.searchParams.set('resource', 'https://other.example.com/mcp')

		const res = await call(new Request(url.toString()))
		expect(res.status).toBe(400)
		expect(res.headers.get('Location')).toBeNull()
	})

	it.each(RESOURCE_SHAPES)('authorize with %s → token → /mcp → refresh → /mcp', async (_label, resource) => {
		const clientId = await registerClient()
		const code = await authorize(clientId, resource)

		const tokenRes = await call(
			form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: VERIFIER, resource }),
		)
		expect(tokenRes.status, await tokenRes.clone().text()).toBe(200)
		const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string }

		expect((await mcpInit(tokens.access_token)).status).toBe(200)

		const refreshRes = await call(form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, resource }))
		expect(refreshRes.status, await refreshRes.clone().text()).toBe(200)
		const refreshed = (await refreshRes.json()) as { access_token: string }

		expect((await mcpInit(refreshed.access_token)).status).toBe(200)
	})
})
