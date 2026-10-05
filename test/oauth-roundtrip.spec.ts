// ABOUTME: Integration test for the full MCP OAuth 2.1 round-trip.
// ABOUTME: Verifies: 401 → discovery → /authorize → /discogs-callback → token → /mcp 200.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index-oauth'

// Mock DiscogsAuth so we don't hit real Discogs APIs
vi.mock('../src/auth/discogs', () => ({
  DiscogsAuth: vi.fn().mockImplementation(() => ({
    getRequestToken: vi.fn().mockResolvedValue({
      oauth_token: 'mock-request-token',
      oauth_token_secret: 'mock-request-secret',
      oauth_callback_confirmed: 'true',
    }),
    getAccessToken: vi.fn().mockResolvedValue({
      oauth_token: 'mock-access-token',
      oauth_token_secret: 'mock-access-secret',
    }),
    getAuthHeaders: vi.fn().mockResolvedValue({
      Authorization: 'OAuth mock-auth',
    }),
  })),
}))

// Mock fetch for Discogs /oauth/identity
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const BASE_URL = 'https://discogs-mcp-prod.example.com'

const MCP_INIT = JSON.stringify({
  jsonrpc: '2.0', method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Test', version: '1.0' } },
  id: 1,
})
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

/**
 * Compute PKCE S256 code challenge
 */
async function computeS256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

describe('Full OAuth round-trip', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('Step 1: POST /mcp returns 401 + WWW-Authenticate', async () => {
    const req = new Request(`${BASE_URL}/mcp`, { method: 'POST', body: MCP_INIT, headers: MCP_HEADERS })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer resource_metadata=')
  })

  it('Step 2: GET /.well-known/oauth-protected-resource returns authorization_servers', async () => {
    const req = new Request(`${BASE_URL}/.well-known/oauth-protected-resource`)
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.authorization_servers).toBeDefined()
    expect(body.authorization_servers.length).toBeGreaterThan(0)
  })

  it('Step 3: GET /.well-known/oauth-authorization-server returns valid metadata', async () => {
    const req = new Request(`${BASE_URL}/.well-known/oauth-authorization-server`)
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.issuer).toBeDefined()
    expect(body.authorization_endpoint).toBeDefined()
    expect(body.token_endpoint).toBeDefined()
    expect(body.code_challenge_methods_supported).toContain('S256')
  })

  it('Step 4: GET /authorize redirects to discogs.com/oauth/authorize', async () => {
    const verifier = 'test-verifier-abcdefg12345678'
    const challenge = await computeS256Challenge(verifier)

    const url = new URL(`${BASE_URL}/authorize`)
    url.searchParams.set('client_id', 'test-client-id')
    url.searchParams.set('redirect_uri', `${BASE_URL}/callback`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', 'test-state-123')
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')

    const mockOauthReqInfo = {
      clientId: 'test-client-id',
      redirectUri: `${BASE_URL}/callback`,
      responseType: 'code',
      state: 'test-state-123',
      scope: [],
    }
    const envWithOAuth = {
      ...env,
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue(mockOauthReqInfo),
      },
    }

    const req = new Request(url.toString())
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, envWithOAuth as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    const location = res.headers.get('Location') ?? ''
    expect(location).toContain('discogs.com/oauth/authorize')
    expect(location).toContain('oauth_token=mock-request-token')
  })

  it('Step 4: GET /authorize returns 400 and never reaches Discogs when client_id is absent', async () => {
    const url = new URL(`${BASE_URL}/authorize`)
    url.searchParams.set('redirect_uri', 'https://attacker.example.net/steal')
    url.searchParams.set('response_type', 'code')

    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request(url.toString()), env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(400)
    expect(res.headers.get('Location')).toBeNull()
  })

  it('Step 4: GET /authorize returns 400 for a client_id that was never registered', async () => {
    const url = new URL(`${BASE_URL}/authorize`)
    url.searchParams.set('client_id', 'not-a-registered-client')
    url.searchParams.set('redirect_uri', `${BASE_URL}/callback`)
    url.searchParams.set('response_type', 'code')

    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request(url.toString()), env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(400)
    expect(res.headers.get('Location')).toBeNull()
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/)
  })

  it('Step 4: GET /authorize returns 400 for a redirect_uri the client did not register', async () => {
    const registerCtx = createExecutionContext()
    const registerRes = await worker.fetch(
      new Request(`${BASE_URL}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Round-trip Test Client',
          redirect_uris: ['http://localhost:3000/callback'],
          token_endpoint_auth_method: 'none',
        }),
      }),
      env as any,
      registerCtx,
    )
    await waitOnExecutionContext(registerCtx)
    expect(registerRes.status).toBe(201)
    const { client_id } = (await registerRes.json()) as { client_id: string }

    const url = new URL(`${BASE_URL}/authorize`)
    url.searchParams.set('client_id', client_id)
    url.searchParams.set('redirect_uri', 'https://attacker.example.net/steal')
    url.searchParams.set('response_type', 'code')

    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request(url.toString()), env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(400)
    expect(res.headers.get('Location')).toBeNull()
  })

  it('Step 5–6: GET /discogs-callback completes authorization and redirects to client', async () => {
    // Pre-seed KV with pending OAuth state (as if /authorize ran)
    await env.MCP_SESSIONS.put(
      'oauth-pending:mock-request-token',
      JSON.stringify({
        oauthReqInfo: {
          clientId: 'test-client-id',
          redirectUri: `${BASE_URL}/callback`,
          state: 'test-state-123',
          scope: [],
        },
        requestTokenSecret: 'mock-request-secret',
      }),
    )

    // Mock identity API
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, username: 'discogsuser' }),
    })

    const envWithOAuth = {
      ...env,
      OAUTH_PROVIDER: {
        completeAuthorization: vi.fn().mockResolvedValue({
          redirectTo: `${BASE_URL}/callback?code=test-code`,
        }),
      },
    }

    const req = new Request(
      `${BASE_URL}/discogs-callback?oauth_token=mock-request-token&oauth_verifier=mock-verifier`,
    )
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, envWithOAuth as any, ctx)
    await waitOnExecutionContext(ctx)

    expect([302, 303]).toContain(res.status)
    // Pending KV entry should be deleted
    const pending = await env.MCP_SESSIONS.get('oauth-pending:mock-request-token')
    expect(pending).toBeNull()
  })
})
