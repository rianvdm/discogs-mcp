// ABOUTME: Tests for DiscogsOAuthHandler auth routes.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DiscogsOAuthHandler, checkAllowlist } from '../../src/auth/oauth-handler'
import { tokenMirrorKey } from '../../src/sync/keys'

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
  const stubKv = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace

  it('returns null when allowlist is unset (open instance)', async () => {
    expect(await checkAllowlist(identity, undefined, undefined, stubKv)).toBeNull()
  })

  it('returns null when allowlist is empty string (open instance)', async () => {
    expect(await checkAllowlist(identity, '', '', stubKv)).toBeNull()
    expect(await checkAllowlist(identity, '   ', '   ', stubKv)).toBeNull()
  })

  it('returns null when numeric ID matches', async () => {
    expect(await checkAllowlist(identity, '2579319', undefined, stubKv)).toBeNull()
  })

  it('trims whitespace before comparing', async () => {
    expect(await checkAllowlist(identity, '  2579319  ', undefined, stubKv)).toBeNull()
  })

  it('returns a 403 HTML response when numeric ID does not match', async () => {
    const res = await checkAllowlist(identity, '99999', undefined, stubKv)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    expect(res!.headers.get('Content-Type')).toContain('text/html')
    const body = await res!.text()
    expect(body).toContain('Access Restricted')
    expect(body).toContain('github.com/rianvdm/discogs-mcp')
  })

  it('compares by numeric ID, not username (usernames are mutable)', async () => {
    const res = await checkAllowlist(
      { id: 111, username: 'elezea-records' },
      '2579319',
      undefined,
      stubKv,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('accepts a comma-separated list and allows any match', async () => {
    expect(await checkAllowlist(identity, '111,2579319,222', undefined, stubKv)).toBeNull()
    expect(
      await checkAllowlist({ id: 111, username: 'a' }, '111,2579319,222', undefined, stubKv),
    ).toBeNull()
    expect(
      await checkAllowlist({ id: 222, username: 'b' }, '111,2579319,222', undefined, stubKv),
    ).toBeNull()
  })

  it('rejects when numeric ID is absent from the list', async () => {
    const res = await checkAllowlist(
      { id: 999, username: 'nope' },
      '111,2579319,222',
      undefined,
      stubKv,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('trims whitespace around list entries', async () => {
    expect(
      await checkAllowlist(identity, ' 111 , 2579319 , 222 ', undefined, stubKv),
    ).toBeNull()
  })

  it('ignores empty entries in the list (e.g. trailing commas)', async () => {
    expect(await checkAllowlist(identity, '2579319,,,', undefined, stubKv)).toBeNull()
    const res = await checkAllowlist(
      { id: 999, username: 'nope' },
      ',,,',
      undefined,
      stubKv,
    )
    expect(res).toBeNull() // all-empty = open instance
  })
})

describe('checkAllowlist with usernames', () => {
  const identity = { id: 2579319, username: 'elezea-records' }

  function makeKv() {
    const store = new Map<string, string>()
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value)
      }),
      _store: store,
    } as unknown as KVNamespace & { _store: Map<string, string> }
  }

  beforeEach(async () => {
    mockFetch.mockReset()
    const { _resetHotCacheForTests } = await import('../../src/auth/usernameResolver')
    _resetHotCacheForTests()
  })

  it('allows when only ALLOWED_DISCOGS_USERNAMES matches (resolved via fetch)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 2579319, username: 'elezea-records' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const kv = makeKv()
    const res = await checkAllowlist(identity, undefined, 'elezea-records', kv)
    expect(res).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.discogs.com/users/elezea-records')
    // KV cache populated for cross-isolate reuse
    expect(await kv.get('username-id:elezea-records')).toBe('2579319')
  })

  it('merges username and numeric-id allowlists', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 111, username: 'somebody' }), { status: 200 }),
    )
    const kv = makeKv()
    // identity (2579319) matches the numeric list; username 'somebody' is also allowed
    const res = await checkAllowlist(identity, '2579319', 'somebody', kv)
    expect(res).toBeNull()
  })

  it('rejects when username resolution fails (404) and no other entry matches', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
    const kv = makeKv()
    const res = await checkAllowlist(identity, undefined, 'definitelynotreal', kv)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('uses KV cache on second call without re-fetching', async () => {
    const kv = makeKv()
    await kv.put('username-id:elezea-records', '2579319')
    const res = await checkAllowlist(identity, undefined, 'elezea-records', kv)
    expect(res).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('short-circuits when numeric ID already matches static list (no fetch, no KV read)', async () => {
    // When the caller's numeric ID is already accepted by ALLOWED_DISCOGS_USER_ID,
    // there's no reason to resolve any usernames — every cold isolate would
    // otherwise fan out a fetch per configured username before answering.
    const kv = makeKv()
    const res = await checkAllowlist(identity, '2579319', 'alice,bob,carol', kv)
    expect(res).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(kv.get).not.toHaveBeenCalled()
  })

  it('lowercases the username before lookup', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 2579319, username: 'elezea-records' }), { status: 200 }),
    )
    const kv = makeKv()
    const res = await checkAllowlist(identity, undefined, 'Elezea-Records', kv)
    expect(res).toBeNull()
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.discogs.com/users/elezea-records')
    expect(await kv.get('username-id:elezea-records')).toBe('2579319')
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

  it('mirrors the access token under discogs:token:{userId} for cron access', async () => {
    await env.MCP_SESSIONS.put(
      'oauth-pending:mirror-mcp-token',
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

    // Numeric id is what the mirror is keyed on
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 555555, username: 'mcpmirroruser' }),
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
      'https://example.com/discogs-callback?oauth_token=mirror-mcp-token&oauth_verifier=mock-verifier',
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, envWithOAuth as any, ctx)
    await waitOnExecutionContext(ctx)

    expect([302, 303]).toContain(res.status)

    const mirrored = await env.MCP_SESSIONS.get(tokenMirrorKey('555555'))
    expect(mirrored).not.toBeNull()
    const mirrorData = JSON.parse(mirrored!)
    expect(mirrorData).toEqual({
      numericId: '555555',
      username: 'mcpmirroruser',
      accessToken: 'mock-access-token',
      accessTokenSecret: 'mock-access-secret',
    })
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

  it('mirrors the access token under discogs:token:{userId} for cron access', async () => {
    const csrfToken = 'mirror-csrf-token'
    await env.MCP_SESSIONS.put(
      'login-pending:mirror-path',
      JSON.stringify({
        sessionId: 'mirror-path',
        csrfToken,
        requestToken: 'mock-request-token',
        requestTokenSecret: 'mock-request-secret',
        fromMcpClient: true,
        timestamp: Date.now(),
      }),
    )

    // Mock identity fetch — numeric id is what the mirror is keyed on
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 424242, username: 'mirroruser' }),
    })

    const req = new Request(
      'https://example.com/callback?session_id=mirror-path&oauth_token=mock-request-token&oauth_verifier=mock-verifier',
      { headers: { Cookie: `__Host-csrf=${csrfToken}` } },
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)

    const mirrored = await env.MCP_SESSIONS.get(tokenMirrorKey('424242'))
    expect(mirrored).not.toBeNull()
    const mirrorData = JSON.parse(mirrored!)
    expect(mirrorData).toEqual({
      numericId: '424242',
      username: 'mirroruser',
      accessToken: 'mock-access-token',
      accessTokenSecret: 'mock-access-secret',
    })
  })
})
