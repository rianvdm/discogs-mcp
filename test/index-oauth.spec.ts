// ABOUTME: Tests for src/index-oauth.ts — routing, 401 behavior, session paths, discovery.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, it, expect } from 'vitest'
import worker from '../src/index-oauth'

// MCP initialize request body (required for the MCP handler to respond)
const MCP_INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'TestClient', version: '1.0.0' },
  },
  id: 1,
})

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

describe('POST /mcp — unauthenticated', () => {
  it('returns 401', async () => {
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
  })

  it('includes WWW-Authenticate with resource_metadata', async () => {
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.headers.get('WWW-Authenticate')).toContain(
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
    )
  })

  it('does not contain a copy-paste login URL in the body', async () => {
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    const body = await res.text()
    expect(body).not.toContain('/login?session_id=')
    expect(body).not.toContain('/login?connection_id=')
  })
})

describe('POST /mcp — session_id param path', () => {
  it('returns 401 JSON (no WWW-Authenticate) when session not in KV', async () => {
    const req = new Request('https://example.com/mcp?session_id=nonexistent', {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
    // Must NOT have WWW-Authenticate — this is an explicit session claim
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
    const body = await res.json() as any
    expect(body.error).toBe('invalid_session')
  })

  it('returns 200 when session_id has a valid KV entry', async () => {
    const sessionId = 'test-valid-session'
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({
        username: 'testuser',
        numericId: '12345',
        accessToken: 'tok',
        accessTokenSecret: 'sec',
        expiresAt: Date.now() + 60 * 60 * 1000,
        sessionId,
      }),
    )
    const req = new Request(`https://example.com/mcp?session_id=${sessionId}`, {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
  })

  it('surfaces the KV session expiry through auth_status', async () => {
    const sessionId = 'test-expiry-session'
    // Relative, not a calendar date: a fixed date passes until the day it
    // arrives, after which the session reads as expired and /mcp answers 401.
    // Whole seconds, because the session carries exp in seconds.
    const expiresAt = Math.floor(Date.now() / 1000) * 1000 + 24 * 60 * 60 * 1000
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({ username: 'testuser', numericId: '12345', accessToken: 'tok', accessTokenSecret: 'sec', expiresAt, sessionId }),
    )
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'auth_status', arguments: {} }, id: 2 })
    const req = new Request(`https://example.com/mcp?session_id=${sessionId}`, { method: 'POST', body, headers: MCP_HEADERS })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain(`Session expires: ${new Date(expiresAt).toISOString()}`)
  })
})

describe('POST /mcp — legacy Mcp-Session-Id header', () => {
  // MCP 2026-07-28 has no Mcp-Session-Id header. The server neither routes on it
  // nor echoes it; only the repo's own ?session_id= parameter selects the session path.
  it('ignores the header and falls through to OAuth, even when a KV session with that id exists', async () => {
    const sessionId = 'mcp-header-session'
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({
        username: 'testuser2',
        numericId: '67890',
        accessToken: 'tok2',
        accessTokenSecret: 'sec2',
        expiresAt: Date.now() + 60 * 60 * 1000,
        sessionId,
      }),
    )
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY,
      headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId },
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer resource_metadata=')
    expect(res.headers.get('Mcp-Session-Id')).toBeNull()
  })

  it('does not echo the header on the session path', async () => {
    const sessionId = 'session-path-no-echo'
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({ username: 'testuser', numericId: '12345', accessToken: 'tok', accessTokenSecret: 'sec', expiresAt: Date.now() + 60_000, sessionId }),
    )
    const req = new Request(`https://example.com/mcp?session_id=${sessionId}`, {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Mcp-Session-Id')).toBeNull()
  })

  it('does not advertise the header in CORS preflight', async () => {
    const req = new Request('https://example.com/mcp', { method: 'OPTIONS' })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Headers')).not.toContain('Mcp-Session-Id')
    expect(res.headers.get('Access-Control-Expose-Headers')).toBeNull()
    for (const h of ['MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name']) {
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain(h)
    }
  })
})

describe('POST /mcp — browser Origin policy', () => {
  // Non-browser clients (Claude.ai, Claude Code, Desktop) send no Origin and are
  // always accepted. Browser clients must come from the custom domain or local dev
  // tooling. The handler option replaces its defaults, so localhost is listed explicitly.
  const sessionId = 'origin-policy-session'

  async function postWithOrigin(origin?: string, host = 'discogs-mcp.com'): Promise<Response> {
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({ username: 'testuser', numericId: '12345', accessToken: 'tok', accessTokenSecret: 'sec', expiresAt: Date.now() + 60_000, sessionId }),
    )
    // A real HTTP client always sends Host; the handler validates it on workers.dev endpoints.
    const headers: Record<string, string> = { ...MCP_HEADERS, Host: host }
    if (origin) headers.Origin = origin
    const req = new Request(`https://${host}/mcp?session_id=${sessionId}`, { method: 'POST', body: MCP_INIT_BODY, headers })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    return res
  }

  it('accepts requests with no Origin', async () => {
    expect((await postWithOrigin()).status).toBe(200)
  })

  it('accepts browser requests from the custom domain', async () => {
    expect((await postWithOrigin('https://discogs-mcp.com')).status).toBe(200)
  })

  it('rejects browser requests from an unknown Origin', async () => {
    expect((await postWithOrigin('https://evil.example')).status).toBe(403)
  })

  it('accepts localhost Origins for the MCP inspector against wrangler dev', async () => {
    expect((await postWithOrigin('http://localhost:6274')).status).toBe(200)
  })

  it('accepts a self-hosted deployment\'s own Origin, whatever its hostname', async () => {
    const host = 'discogs-mcp.someone.workers.dev'
    expect((await postWithOrigin(`https://${host}`, host)).status).toBe(200)
  })

  it('still rejects a foreign Origin on a self-hosted deployment', async () => {
    expect((await postWithOrigin('https://discogs-mcp.com', 'discogs-mcp.someone.workers.dev')).status).toBe(403)
  })
})

describe('POST /mcp — protocol lanes through the session path', () => {
  interface WireRecord {
    httpMethod: string
    rpcMethod: string | null
    mcpMethodHeader: string | null
    versionHeader: string | null
  }

  // A real SDK v2 client routed at worker.fetch, recording every request it makes,
  // so the assertions are on the actual wire shape rather than a hand-rolled one.
  async function connectRecordingClient(sessionId: string, versionMode: 'legacy' | { pin: string }) {
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({ username: 'testuser', numericId: '12345', accessToken: 'tok', accessTokenSecret: 'sec', expiresAt: Date.now() + 60_000, sessionId }),
    )
    const seen: WireRecord[] = []
    const transport = new StreamableHTTPClientTransport(new URL(`https://discogs-mcp.com/mcp?session_id=${sessionId}`), {
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { method?: string }) : {}
        seen.push({
          httpMethod: request.method,
          rpcMethod: body.method ?? null,
          mcpMethodHeader: request.headers.get('Mcp-Method'),
          versionHeader: request.headers.get('MCP-Protocol-Version'),
        })
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        return response
      },
    })
    const client = new Client({ name: 'lane-test', version: '0.0.0' }, { versionNegotiation: { mode: versionMode } })
    await client.connect(transport)
    return { client, seen }
  }

  async function exerciseTools(client: Client) {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('search_collection')
    const pong = await client.callTool({ name: 'ping', arguments: { message: 'lane check' } })
    expect(JSON.stringify(pong.content)).toContain('Pong! You said: lane check')
  }

  it('serves a 2026-07-28 client on the stateless lane (server/discover, no initialize)', async () => {
    // Pinning makes the client fail loudly if the server cannot offer 2026-07-28,
    // so this cannot pass by silently falling back to the legacy lane.
    const { client, seen } = await connectRecordingClient('modern-lane-session', { pin: '2026-07-28' })
    await exerciseTools(client)

    expect(seen[0]?.rpcMethod).toBe('server/discover')
    expect(seen.some((r) => r.rpcMethod === 'initialize')).toBe(false)
    const posts = seen.filter((r) => r.httpMethod === 'POST')
    expect(posts.every((r) => r.versionHeader === '2026-07-28')).toBe(true)
    expect(posts.every((r) => r.mcpMethodHeader === r.rpcMethod)).toBe(true)
    expect(seen.map((r) => r.rpcMethod)).toContain('tools/call')

    await client.close()
  })

  it('still serves a legacy 2025 client through the compatibility fallback (initialize)', async () => {
    // Published Claude clients still negotiate the initialize-era protocol; the
    // handler's default legacy lane must keep serving them.
    const { client, seen } = await connectRecordingClient('legacy-lane-session', 'legacy')
    await exerciseTools(client)

    expect(seen[0]?.rpcMethod).toBe('initialize')
    expect(seen.some((r) => r.rpcMethod === 'server/discover')).toBe(false)
    expect(seen.map((r) => r.rpcMethod)).toContain('tools/call')

    await client.close()
  })
})

describe('GET /.well-known/mcp.json', () => {
  it('advertises the 2026-07-28 protocol revision and the server version', async () => {
    const req = new Request('https://example.com/.well-known/mcp.json')
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.protocolVersion).toBe('2026-07-28')
    expect(body.serverInfo.name).toBe('discogs-mcp')
    expect(body.transport).toEqual({ type: 'streamable-http', endpoint: '/mcp' })
  })
})

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns 200 with required fields', async () => {
    const req = new Request('https://example.com/.well-known/oauth-protected-resource')
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.resource).toBe('https://example.com')
    expect(body.authorization_servers).toContain('https://example.com')
    expect(body.bearer_methods_supported).toContain('header')
  })
})

describe('GET /.well-known/oauth-authorization-server', () => {
  it('returns 200 with all MCP-required fields', async () => {
    const req = new Request('https://example.com/.well-known/oauth-authorization-server')
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.issuer).toBeDefined()
    expect(body.authorization_endpoint).toBeDefined()
    expect(body.token_endpoint).toBeDefined()
    expect(body.response_types_supported).toContain('code')
    expect(body.grant_types_supported).toContain('authorization_code')
    expect(body.code_challenge_methods_supported).toContain('S256')
  })
})

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const req = new Request('https://example.com/health')
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe('ok')
  })
})

describe('GET / — marketing page', () => {
  it('returns 200', async () => {
    const req = new Request('https://example.com/', { method: 'GET' })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
  })

  it('returns HTML content type', async () => {
    const req = new Request('https://example.com/', { method: 'GET' })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })

  it('contains Discogs MCP in the body', async () => {
    const req = new Request('https://example.com/', { method: 'GET' })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    const body = await res.text()
    expect(body).toContain('Discogs MCP')
  })

  it('links to the self-hosting guide', async () => {
    const req = new Request('https://example.com/', { method: 'GET' })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    const body = await res.text()
    expect(body).toContain('github.com/rianvdm/discogs-mcp#deploy-your-own-copy')
    expect(body).toContain('private instance')
  })
})
