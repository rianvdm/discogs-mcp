// ABOUTME: Tests for src/index-oauth.ts — routing, 401 behavior, session paths, discovery.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
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
})

describe('POST /mcp — Mcp-Session-Id header', () => {
  it('returns 401 + WWW-Authenticate when Mcp-Session-Id has no KV entry', async () => {
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY,
      headers: { ...MCP_HEADERS, 'Mcp-Session-Id': 'no-such-session' },
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer resource_metadata=')
  })

  it('returns 200 when Mcp-Session-Id has a valid KV entry', async () => {
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
    expect(res.status).toBe(200)
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
    expect(body).toContain('github.com/rianvdm/discogs-mcp#-self-hosting')
    expect(body).toContain('private instance')
  })
})
