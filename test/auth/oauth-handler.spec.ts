// ABOUTME: Tests for DiscogsOAuthHandler auth routes.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { DiscogsOAuthHandler, checkAllowlist } from '../../src/auth/oauth-handler'

// Mock DiscogsAuth at the top of the file (add after existing imports)
vi.mock('../../src/auth/discogs', () => ({
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
    getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'OAuth mock-header' }),
  })),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('checkAllowlist', () => {
  const identity = { id: 2579319, username: 'elezea-records' }

  it('returns null when allowlist is unset (open instance)', () => {
    expect(checkAllowlist(identity, undefined)).toBeNull()
  })

  it('returns null when allowlist is empty string (open instance)', () => {
    expect(checkAllowlist(identity, '')).toBeNull()
    expect(checkAllowlist(identity, '   ')).toBeNull()
  })

  it('returns null when numeric ID matches', () => {
    expect(checkAllowlist(identity, '2579319')).toBeNull()
  })

  it('trims whitespace before comparing', () => {
    expect(checkAllowlist(identity, '  2579319  ')).toBeNull()
  })

  it('returns a 403 HTML response when numeric ID does not match', async () => {
    const res = checkAllowlist(identity, '99999')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    expect(res!.headers.get('Content-Type')).toContain('text/html')
    const body = await res!.text()
    expect(body).toContain('Access Restricted')
    expect(body).toContain('github.com/rianvdm/discogs-mcp')
  })

  it('compares by numeric ID, not username (usernames are mutable)', () => {
    const res = checkAllowlist({ id: 111, username: 'elezea-records' }, '2579319')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })
})

describe('/.well-known/oauth-protected-resource', () => {
  it('returns 200 with correct fields', async () => {
    const req = new Request('https://example.com/.well-known/oauth-protected-resource')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.resource).toBe('https://example.com')
    expect(body.authorization_servers).toContain('https://example.com')
    expect(body.bearer_methods_supported).toContain('header')
  })

  it('is accessible without authentication', async () => {
    const req = new Request('https://example.com/.well-known/oauth-protected-resource')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    // Must not be 401 or 403 — unauthenticated clients need to read this
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})

describe('/authorize', () => {
  it('redirects to discogs.com/oauth/authorize with the request token', async () => {
    const url = new URL('https://example.com/authorize')
    url.searchParams.set('client_id', 'test-client')
    url.searchParams.set('redirect_uri', 'https://client/callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', 'random123')
    url.searchParams.set('code_challenge', 'abc123')
    url.searchParams.set('code_challenge_method', 'S256')

    const mockOauthReqInfo = {
      clientId: 'test-client',
      redirectUri: 'https://client/callback',
      responseType: 'code',
      state: 'random123',
    }
    const envWithOAuth = {
      ...env,
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue(mockOauthReqInfo),
      },
    }

    const req = new Request(url.toString())
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, envWithOAuth as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    const location = res.headers.get('Location') ?? ''
    expect(location).toContain('discogs.com/oauth/authorize')
    expect(location).toContain('oauth_token=mock-request-token')
  })
})

describe('/discogs-callback', () => {
  it('completes authorization and redirects to client redirect_uri', async () => {
    // Pre-seed KV with a pending oauth state
    await env.MCP_SESSIONS.put(
      'oauth-pending:mock-request-token',
      JSON.stringify({
        oauthReqInfo: {
          clientId: 'test-client',
          redirectUri: 'https://client/callback',
          state: 'random123',
          scope: [],
        },
        requestTokenSecret: 'mock-request-secret',
      }),
    )

    // Mock Discogs /oauth/identity response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 12345, username: 'testuser' }),
    })

    const envWithOAuth = {
      ...env,
      OAUTH_PROVIDER: {
        completeAuthorization: vi.fn().mockResolvedValue({
          redirectTo: 'https://client/callback?code=test',
        }),
      },
    }

    const req = new Request(
      'https://example.com/discogs-callback?oauth_token=mock-request-token&oauth_verifier=mock-verifier',
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, envWithOAuth as any, ctx)
    await waitOnExecutionContext(ctx)

    // Should redirect (302) — library issues the code redirect to client
    expect([302, 303]).toContain(res.status)
  })

  it('returns 400 when oauth_token is missing', async () => {
    const req = new Request('https://example.com/discogs-callback')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 when KV entry is missing (expired)', async () => {
    const req = new Request(
      'https://example.com/discogs-callback?oauth_token=no-such-token&oauth_verifier=x',
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(400)
  })
})

describe('/login (manual path)', () => {
  it('redirects to discogs.com/oauth/authorize', async () => {
    const req = new Request('https://example.com/login?session_id=test-session')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    const location = res.headers.get('Location') ?? ''
    expect(location).toContain('discogs.com/oauth/authorize')
  })

  it('sets a CSRF cookie', async () => {
    const req = new Request('https://example.com/login?session_id=test-session')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    const cookie = res.headers.get('Set-Cookie') ?? ''
    expect(cookie).toContain('csrf')
  })

  it('stores pending login state in KV', async () => {
    const req = new Request('https://example.com/login?session_id=test-session-kv')
    const ctx = createExecutionContext()
    await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    const stored = await env.MCP_SESSIONS.get('login-pending:test-session-kv')
    expect(stored).not.toBeNull()
    const data = JSON.parse(stored!)
    expect(data.csrfToken).toBeDefined()
    expect(data.requestToken).toBeDefined()
    expect(data.requestTokenSecret).toBeDefined()
  })
})

describe('/callback (manual path)', () => {
  it('returns 400 when login-pending KV entry is missing', async () => {
    const req = new Request(
      'https://example.com/callback?session_id=no-such-session&oauth_token=x&oauth_verifier=y',
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(400)
  })

  it('returns 403 when CSRF token is missing', async () => {
    const csrfToken = 'test-csrf-token'
    await env.MCP_SESSIONS.put(
      'login-pending:csrf-test',
      JSON.stringify({
        sessionId: 'csrf-test',
        csrfToken,
        requestToken: 'tok',
        requestTokenSecret: 'sec',
        fromMcpClient: true,
        timestamp: Date.now(),
      }),
    )
    const req = new Request(
      'https://example.com/callback?session_id=csrf-test&oauth_token=tok&oauth_verifier=x',
      // No cookie
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(403)
  })

  it('stores session in KV and returns HTML success page when CSRF is valid', async () => {
    const csrfToken = 'valid-csrf-token'
    await env.MCP_SESSIONS.put(
      'login-pending:happy-path',
      JSON.stringify({
        sessionId: 'happy-path',
        csrfToken,
        requestToken: 'mock-request-token',
        requestTokenSecret: 'mock-request-secret',
        fromMcpClient: true,
        timestamp: Date.now(),
      }),
    )

    // Mock identity fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 99, username: 'happyuser' }),
    })

    // URL is https so cookie name is __Host-csrf
    const req = new Request(
      'https://example.com/callback?session_id=happy-path&oauth_token=mock-request-token&oauth_verifier=mock-verifier',
      { headers: { Cookie: `__Host-csrf=${csrfToken}` } },
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Authentication Successful')

    const session = await env.MCP_SESSIONS.get('session:happy-path')
    expect(session).not.toBeNull()
    const sessionData = JSON.parse(session!)
    expect(sessionData.username).toBe('happyuser')
  })
})
