// ABOUTME: Integration test for the manual login path (/login → /callback → /mcp?session_id=).
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index-oauth'

vi.mock('../src/auth/discogs', () => ({
  DiscogsAuth: vi.fn().mockImplementation(function () {
    return {
      getRequestToken: vi.fn().mockResolvedValue({
        oauth_token: 'manual-request-token',
        oauth_token_secret: 'manual-request-secret',
        oauth_callback_confirmed: 'true',
      }),
      getAccessToken: vi.fn().mockResolvedValue({
        oauth_token: 'manual-access-token',
        oauth_token_secret: 'manual-access-secret',
      }),
      getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'OAuth mock' }),
    }
  }),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const BASE_URL = 'https://example.com'
const SESSION_ID = 'manual-test-session'

const MCP_INIT = JSON.stringify({
  jsonrpc: '2.0', method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Test', version: '1.0' } },
  id: 1,
})
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

describe('Manual login round-trip', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('Step 1: GET /login redirects to Discogs and stores pending state', async () => {
    const req = new Request(`${BASE_URL}/login?session_id=${SESSION_ID}`)
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('discogs.com/oauth/authorize')

    // Capture CSRF cookie for step 2
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('csrf')

    // Verify KV entry was written
    const pending = await env.MCP_SESSIONS.get(`login-pending:${SESSION_ID}`)
    expect(pending).not.toBeNull()
    const data = JSON.parse(pending!)
    expect(data.csrfToken).toBeDefined()
    expect(data.requestToken).toBe('manual-request-token')
  })

  it('Step 2: GET /callback with valid CSRF stores session and returns success page', async () => {
    // Seed pending state
    const csrfToken = 'test-csrf-manual'
    await env.MCP_SESSIONS.put(
      `login-pending:${SESSION_ID}`,
      JSON.stringify({
        sessionId: SESSION_ID,
        csrfToken,
        requestToken: 'manual-request-token',
        requestTokenSecret: 'manual-request-secret',
        fromMcpClient: true,
        timestamp: Date.now(),
      }),
    )

    // Mock identity API
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 777, username: 'manualuser' }),
    })

    const req = new Request(
      `${BASE_URL}/callback?session_id=${SESSION_ID}&oauth_token=manual-request-token&oauth_verifier=manual-verifier`,
      { headers: { Cookie: `__Host-csrf=${csrfToken}` } }, // HTTPS uses __Host-csrf
    )
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Authentication Successful')
    expect(body).toContain('manualuser')

    const session = await env.MCP_SESSIONS.get(`session:${SESSION_ID}`)
    expect(session).not.toBeNull()
    const sessionData = JSON.parse(session!)
    expect(sessionData.username).toBe('manualuser')
  })

  it('Step 3: POST /mcp?session_id=... returns 200 after successful login', async () => {
    // Seed valid session (as if step 2 completed)
    await env.MCP_SESSIONS.put(
      `session:${SESSION_ID}`,
      JSON.stringify({
        username: 'manualuser',
        numericId: '777',
        accessToken: 'manual-access-token',
        accessTokenSecret: 'manual-access-secret',
        expiresAt: Date.now() + 60 * 60 * 1000,
        sessionId: SESSION_ID,
      }),
    )

    const req = new Request(`${BASE_URL}/mcp?session_id=${SESSION_ID}`, {
      method: 'POST', body: MCP_INIT, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
  })
})
