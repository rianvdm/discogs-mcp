// ABOUTME: Main entry point supporting MCP OAuth 2.1 and session-based authentication.
// ABOUTME: Routes /mcp requests to session handler or OAuth provider based on auth state.
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types'
import { createMcpHandler } from 'agents/mcp'

import { DiscogsOAuthHandler, parseAllowlist, type DiscogsUserProps } from './auth/oauth-handler'
import { parseUsernameList, resolveUsernamesToIds } from './auth/usernameResolver'
import { DiscogsClient } from './clients/discogs'
import { MARKETING_PAGE_HTML } from './marketing-page.js'
import { createMcpServer } from './mcp/server'
import { syncCollection, type SyncClient } from './sync/collectionSync'
import { tokenMirrorKey } from './sync/keys'
import type { SyncResult, TokenMirror } from './sync/types'
import type { Env } from './types/env'

// Re-export Durable Object class for Wrangler binding
export { DiscogsRateLimiter } from './rate-limiter/durable-object'

const SERVER_VERSION = '1.0.0'

// PKCE + standard MCP session TTL (7 days)
const ACCESS_TOKEN_TTL = 7 * 24 * 60 * 60

/**
 * Enforce ALLOWED_DISCOGS_USER_ID / ALLOWED_DISCOGS_USERNAMES on authenticated
 * MCP requests. Primary gate is at the OAuth callback, but we also check here
 * so that any pre-existing grants/sessions issued before the allowlist was set
 * are invalidated on their next request.
 */
async function isAllowedUser(numericId: string | undefined, env: Env): Promise<boolean> {
  const numericIds = parseAllowlist(env.ALLOWED_DISCOGS_USER_ID)
  const parsedUsernames = parseUsernameList(env.ALLOWED_DISCOGS_USERNAMES)
  if (numericIds.length === 0 && parsedUsernames.length === 0) return true
  // Fast path: if the caller's numeric ID is already in the static list, skip
  // username resolution entirely (avoids a fetch-per-name fan-out on cold isolates).
  if (numericId && numericIds.includes(numericId)) return true
  const usernameIds = await resolveUsernamesToIds(parsedUsernames, env.MCP_SESSIONS)
  const allowed = new Set([...numericIds, ...usernameIds])
  return !!numericId && allowed.has(numericId)
}

function accessDeniedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'access_denied',
      error_description:
        'This Discogs MCP instance is private. Self-host your own: https://github.com/rianvdm/discogs-mcp#self-hosting',
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  )
}

/**
 * OAuth provider instance — handles all OAuth 2.1 endpoints automatically:
 * - /.well-known/oauth-authorization-server (discovery)
 * - /oauth/register (dynamic client registration)
 * - /oauth/token (token exchange)
 * - All routes not intercepted by the main fetch handler
 */
const oauthProvider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // This runs only for OAuth-authenticated requests (valid bearer token).
      // workers-oauth-provider injects the user props from completeAuthorization() into ctx.props.
      const url = new URL(request.url)
      const baseUrl = `${url.protocol}//${url.host}`

      const { server, setContext } = createMcpServer(env, baseUrl)

      const props = (ctx as unknown as { props?: DiscogsUserProps }).props
      if (props && !(await isAllowedUser(props.numericId, env))) {
        return accessDeniedResponse()
      }
      if (props?.username && props?.accessToken) {
        setContext({
          session: {
            username: props.username,
            numericId: props.numericId,
            accessToken: props.accessToken,
            accessTokenSecret: props.accessTokenSecret,
          },
        })
      }

      return createMcpHandler(server)(request, env, ctx)
    },
  },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  defaultHandler: DiscogsOAuthHandler,
  accessTokenTTL: ACCESS_TOKEN_TTL,
})

/**
 * Handle MCP request using a pre-existing KV session (session_id param or Mcp-Session-Id header).
 * Two call paths:
 *   - session_id param: called unconditionally, handles KV miss internally
 *   - Mcp-Session-Id header: only called after router verifies KV entry exists
 */
async function handleSessionBasedMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<Response> {
  const url = new URL(request.url)
  const baseUrl = `${url.protocol}//${url.host}`

  const sessionDataStr = await env.MCP_SESSIONS.get(`session:${sessionId}`)

  if (!sessionDataStr) {
    return new Response(JSON.stringify({ error: 'invalid_session' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      // Intentionally no WWW-Authenticate header — client should not retry via OAuth
    })
  }

  const sessionData = JSON.parse(sessionDataStr)

  if (!(await isAllowedUser(sessionData.numericId, env))) {
    // Delete the stale unauthorized session so retry fails cleanly with 401
    await env.MCP_SESSIONS.delete(`session:${sessionId}`)
    return accessDeniedResponse()
  }

  if (sessionData.expiresAt && Date.now() > sessionData.expiresAt) {
    return new Response(JSON.stringify({ error: 'session_expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { server, setContext } = createMcpServer(env, baseUrl)
  setContext({
    session: {
      username: sessionData.username,
      numericId: sessionData.numericId,
      accessToken: sessionData.accessToken,
      accessTokenSecret: sessionData.accessTokenSecret,
    },
    sessionId,
  })

  const handler = createMcpHandler(server)
  const response = await handler(request, env, ctx)

  const newHeaders = new Headers(response.headers)
  newHeaders.set('Mcp-Session-Id', sessionId)
  newHeaders.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}

/**
 * Strip the 'resource' parameter from OAuth token requests.
 * Claude.ai sends the full MCP endpoint URL as `resource`, but workers-oauth-provider
 * validates audience against ${protocol}//${host} only. Stripping prevents audience mismatch.
 * Only applied when Content-Type is application/x-www-form-urlencoded.
 */
async function stripResourceParam(request: Request): Promise<Request> {
  if (request.method !== 'POST') return request
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/x-www-form-urlencoded')) return request

  const body = await request.text()
  const params = new URLSearchParams(body)

  if (!params.has('resource')) {
    return new Request(request.url, { method: request.method, headers: request.headers, body })
  }

  params.delete('resource')
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: params.toString(),
  })
}

async function logSyncOutcome(_env: Env, numericId: string, result: SyncResult): Promise<void> {
  const entry = { event: 'sync', timestamp: new Date().toISOString(), numericId, ...result }
  console.log(JSON.stringify(entry))
}

// Note on concurrency: users in ALLOWED_DISCOGS_USER_ID are processed sequentially.
// With an allowlist of 1-2 users (the maintainer + occasional shared account),
// sequential is well within Workers' wall-time budget for scheduled handlers and
// keeps the rate-limiter DO simple. If the allowlist ever grows past ~5 users
// with large collections, switch to Promise.all over the user loop. Don't reach
// for ctx.waitUntil here — that's a fetch-handler pattern; scheduled handlers
// should await everything they care about.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const baseUrl = `${url.protocol}//${url.host}`

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
          'Access-Control-Expose-Headers': 'Mcp-Session-Id',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // Static routes — handled before OAuth provider
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(MARKETING_PAGE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(
        JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), version: SERVER_VERSION }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
      )
    }

    // Debug endpoint — exposes rate limiter state. Gated by DEBUG_TOKEN secret.
    // If DEBUG_TOKEN is unset, returns 404 so self-hosters never expose this accidentally.
    if (url.pathname === '/debug/budget' && request.method === 'GET') {
      const expected = env.DEBUG_TOKEN?.trim()
      if (!expected) {
        return new Response('Not Found', { status: 404 })
      }
      const provided = url.searchParams.get('token')
      if (provided !== expected) {
        return new Response('Unauthorized', { status: 401 })
      }
      const doId = env.RATE_LIMITER.idFromName('discogs-rate-limiter')
      const doStub = env.RATE_LIMITER.get(doId)
      const stateRes = await doStub.fetch(new Request('http://do/state'))
      return new Response(stateRes.body, {
        status: stateRes.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      })
    }

    if (url.pathname === '/.well-known/mcp.json' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          version: '1.0',
          serverInfo: { name: 'discogs-mcp', version: SERVER_VERSION },
          transport: { type: 'streamable-http', endpoint: '/mcp' },
          authentication: { required: false },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
      )
    }

    // /mcp — session routing (applies to both GET and POST)
    if (url.pathname === '/mcp') {
      // 1. Explicit session_id param → session path (handles KV miss internally)
      const sessionId = url.searchParams.get('session_id')
      if (sessionId) {
        return handleSessionBasedMcp(request, env, ctx, sessionId)
      }

      // 2. Mcp-Session-Id header — only route to session path if KV entry exists
      const mcpSessionId = request.headers.get('Mcp-Session-Id')
      if (mcpSessionId) {
        const sessionDataStr = await env.MCP_SESSIONS.get(`session:${mcpSessionId}`)
        if (sessionDataStr) {
          return handleSessionBasedMcp(request, env, ctx, mcpSessionId)
        }
        // No KV entry → fall through to OAuth provider (returns 401 + WWW-Authenticate)
      }

      // 3. Everything else → OAuth provider
      const response = await oauthProvider.fetch(request, env, ctx)

      // Inject WWW-Authenticate on 401 responses from /mcp
      if (response.status === 401) {
        const newHeaders = new Headers(response.headers)
        newHeaders.set(
          'WWW-Authenticate',
          `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        )
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        })
      }

      return response
    }

    // /oauth/token — strip resource param before forwarding
    if (url.pathname === '/oauth/token') {
      request = await stripResourceParam(request)
      return oauthProvider.fetch(request, env, ctx)
    }

    // All other routes → OAuth provider (handles /authorize, /discogs-callback, /login,
    // /callback, /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server)
    return oauthProvider.fetch(request, env, ctx)
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const numericIds = parseAllowlist(env.ALLOWED_DISCOGS_USER_ID)
    const usernameIds = await resolveUsernamesToIds(
      parseUsernameList(env.ALLOWED_DISCOGS_USERNAMES),
      env.MCP_SESSIONS,
    )
    const allowed = [...new Set([...numericIds, ...usernameIds])]

    for (const numericId of allowed) {
      try {
        const tokenStr = await env.MCP_SESSIONS.get(tokenMirrorKey(numericId))
        if (!tokenStr) {
          await logSyncOutcome(env, numericId, { outcome: 'no_token', pagesFetched: 0 })
          continue
        }
        const token = JSON.parse(tokenStr) as TokenMirror

        // Build the Discogs client the same way other call sites do
        // (see src/mcp/tools/authenticated.ts — credentials are passed per call,
        // not via constructor).
        const discogsClient = new DiscogsClient()
        if (env.RATE_LIMITER) {
          const rlId = env.RATE_LIMITER.idFromName('discogs-rate-limiter')
          discogsClient.setRateLimiter(env.RATE_LIMITER.get(rlId))
        }

        // Inline SyncClient: closes over username + creds, calls the existing
        // searchCollection method which already paginates the right endpoint.
        const syncClient: SyncClient = {
          fetchCollectionPage: (opts) =>
            discogsClient.searchCollection(
              token.username,
              token.accessToken,
              token.accessTokenSecret,
              { page: opts.page, per_page: opts.per_page, sort: 'added', sort_order: 'desc' },
              env.DISCOGS_CONSUMER_KEY,
              env.DISCOGS_CONSUMER_SECRET,
            ),
        }

        const result = await syncCollection(syncClient, env.MCP_SESSIONS, numericId, {})
        await logSyncOutcome(env, numericId, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 401 → token revoked. Delete the mirror so the cron stops crashing
        // on this user every hour until they re-authenticate via the MCP flow.
        // Spec §Error Handling: log token_invalid, skip.
        if (/\b401\b|Unauthorized/i.test(msg)) {
          await env.MCP_SESSIONS.delete(tokenMirrorKey(numericId))
          await logSyncOutcome(env, numericId, { outcome: 'token_invalid', pagesFetched: 0, error: msg })
        } else {
          await logSyncOutcome(env, numericId, { outcome: 'crashed', pagesFetched: 0, error: msg })
        }
      }
    }
  },
}
