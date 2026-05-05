// ABOUTME: OAuth handler integrating Discogs authentication with MCP OAuth 2.1.
// ABOUTME: Handles /authorize, /discogs-callback, /login, /callback, and /.well-known/oauth-protected-resource.
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import type { ExecutionContext } from '@cloudflare/workers-types'
import { DiscogsAuth } from './discogs'
import type { Env } from '../types/env'
import { tokenMirrorKey } from '../sync/keys'
import { parseUsernameList, resolveUsernamesToIds } from './usernameResolver'

// Env with OAuth helpers injected by the provider at runtime
interface OAuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers
}

/**
 * Discogs user props stored in the OAuth token.
 * Passed to completeAuthorization() and available in apiHandler via ctx.props.
 */
export interface DiscogsUserProps {
  numericId: string       // Discogs numeric user ID (from /oauth/identity field "id")
  username: string        // Discogs username (from /oauth/identity field "username")
  accessToken: string
  accessTokenSecret: string
}

/**
 * Parse ALLOWED_DISCOGS_USER_ID into a list of numeric IDs.
 * Accepts a single ID ("2579319") or a comma-separated list ("123,456,789").
 * Empty/unset = open instance (no allowlist).
 */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * If either ALLOWED_DISCOGS_USER_ID or ALLOWED_DISCOGS_USERNAMES is non-empty,
 * verify that the authenticated Discogs identity matches one of the allowed
 * numeric IDs (after resolving usernames via the public Discogs API).
 * Returns a 403 response for unauthorized users, or null to proceed.
 * Empty/unset on both = open instance.
 */
export async function checkAllowlist(
  identity: { id: number; username: string },
  allowedIdRaw: string | undefined,
  allowedUsernamesRaw: string | undefined,
  kv: KVNamespace,
): Promise<Response | null> {
  const numericIds = parseAllowlist(allowedIdRaw)
  const parsedUsernames = parseUsernameList(allowedUsernamesRaw)
  // Open instance only when neither var is configured at all.
  // If a var is set but resolution fails (e.g. network error or 404), deny
  // rather than falling back to open — misconfigured allowlist ≠ no allowlist.
  if (numericIds.length === 0 && parsedUsernames.length === 0) return null
  const usernameIds = await resolveUsernamesToIds(parsedUsernames, kv)
  const allowed = new Set([...numericIds, ...usernameIds])
  if (allowed.has(String(identity.id))) return null

  console.warn(
    `[AUTH] Rejected unauthorized user: ${identity.username} (${identity.id})`,
  )
  return new Response(
    `<!DOCTYPE html><html><head><title>Access Restricted</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6;color:#222}h1{color:#b00020}a{color:#0366d6}</style></head><body>
       <h1>Access Restricted</h1>
       <p>This Discogs MCP instance is private and locked to a single Discogs user. Discogs API rate limits are too strict to share across users, so each person needs to run their own deployment.</p>
       <p>Good news: it's open source and easy to self-host on Cloudflare Workers (free tier works fine).</p>
       <p><strong><a href="https://github.com/rianvdm/discogs-mcp#self-hosting">Self-hosting instructions →</a></strong></p>
     </body></html>`,
    { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

/**
 * DefaultHandler for @cloudflare/workers-oauth-provider.
 * Only handles auth-related routes. Static routes (/, /health, etc.) are
 * handled by the main entry point in index-oauth.ts.
 */
export const DiscogsOAuthHandler = {
  async fetch(request: Request, env: OAuthEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    switch (url.pathname) {
      case '/authorize':
        if (request.method === 'GET') return handleAuthorize(request, env)
        return new Response('Method not allowed', { status: 405 })

      case '/discogs-callback':
        if (request.method === 'GET') return handleDiscogsCallback(request, env)
        return new Response('Method not allowed', { status: 405 })

      case '/login':
        if (request.method === 'GET') return handleManualLogin(request, env)
        return new Response('Method not allowed', { status: 405 })

      case '/callback':
        if (request.method === 'GET') return handleManualCallback(request, env)
        return new Response('Method not allowed', { status: 405 })

      case '/.well-known/oauth-protected-resource':
        return handleProtectedResourceMetadata(request)

      default:
        return new Response('Not found', { status: 404 })
    }
  },
}

// ── Stub implementations (filled in subsequent tasks) ──────────────────────────

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  try {
    const oauthReqInfo: AuthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request)

    const url = new URL(request.url)
    const callbackUrl = `${url.protocol}//${url.host}/discogs-callback`

    const discogsAuth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
    const { oauth_token: requestToken, oauth_token_secret: requestTokenSecret } =
      await discogsAuth.getRequestToken(callbackUrl)

    // Store pending state: correlate Discogs oauth_token with our OAuth 2.1 request
    await env.MCP_SESSIONS.put(
      `oauth-pending:${requestToken}`,
      JSON.stringify({ oauthReqInfo, requestTokenSecret }),
      { expirationTtl: 600 }, // 10 minutes
    )

    return Response.redirect(
      `https://www.discogs.com/oauth/authorize?oauth_token=${requestToken}`,
      302,
    )
  } catch (error) {
    console.error('[OAUTH] /authorize error:', error)
    return new Response(
      `<html><body><h1>Authorization Error</h1><p>${error instanceof Error ? error.message : 'Unknown error'}</p><p><a href="/authorize">Try again</a></p></body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    )
  }
}

async function handleDiscogsCallback(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url)
  const oauthToken = url.searchParams.get('oauth_token')
  const oauthVerifier = url.searchParams.get('oauth_verifier')

  if (!oauthToken || !oauthVerifier) {
    return new Response('Missing OAuth parameters', { status: 400 })
  }

  // Retrieve and immediately delete the pending state (prevents replay)
  const pendingKey = `oauth-pending:${oauthToken}`
  const pendingDataStr = await env.MCP_SESSIONS.get(pendingKey)

  if (!pendingDataStr) {
    return new Response(
      '<html><body><h1>Session Expired</h1><p>The authorization session has expired or is invalid. Please try again.</p><p><a href="/authorize">Restart authorization</a></p></body></html>',
      { status: 400, headers: { 'Content-Type': 'text/html' } },
    )
  }

  const pendingData = JSON.parse(pendingDataStr)
  const { oauthReqInfo, requestTokenSecret }: { oauthReqInfo: AuthRequest; requestTokenSecret: string } = pendingData

  // Delete immediately — prevents replay even if subsequent steps fail
  await env.MCP_SESSIONS.delete(pendingKey)

  try {
    // Exchange request token for access token
    const discogsAuth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
    const { oauth_token: accessToken, oauth_token_secret: accessTokenSecret } =
      await discogsAuth.getAccessToken(oauthToken, requestTokenSecret, oauthVerifier)

    // Fetch Discogs identity to get username and numeric ID
    const identityRes = await fetch('https://api.discogs.com/oauth/identity', {
      headers: {
        Authorization: (
          await discogsAuth.getAuthHeaders('https://api.discogs.com/oauth/identity', 'GET', {
            key: accessToken,
            secret: accessTokenSecret,
          })
        ).Authorization,
        'User-Agent': 'discogs-mcp/1.0.0',
      },
    })

    if (!identityRes.ok) {
      throw new Error(`Failed to fetch Discogs identity: ${identityRes.status}`)
    }

    const identity = await identityRes.json() as { id: number; username: string }

    // Allowlist gate (set on maintainer's deployment; empty = open)
    const denied = await checkAllowlist(
      identity,
      env.ALLOWED_DISCOGS_USER_ID,
      env.ALLOWED_DISCOGS_USERNAMES,
      env.MCP_SESSIONS,
    )
    if (denied) return denied

    const userProps: DiscogsUserProps = {
      numericId: String(identity.id),
      username: identity.username,
      accessToken,
      accessTokenSecret,
    }

    // Mirror the access token under a numericId-keyed entry so the cron handler
    // (which has no request context) can sync this user's collection in the background.
    // Same pattern as the manual /callback path; see Task 2 of the collection-sync-cron plan.
    await env.MCP_SESSIONS.put(
      tokenMirrorKey(String(identity.id)),
      JSON.stringify({
        numericId: String(identity.id),
        username: identity.username,
        accessToken,
        accessTokenSecret,
      }),
      // No TTL — outlive sessions so the cron keeps working when MCP clients are idle.
    )

    // Complete the MCP OAuth 2.1 flow — library issues the authorization code to client
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: userProps.username, // OAuth 2.1 subject = username
      metadata: {
        label: 'Discogs MCP Access',
        discogsUsername: userProps.username,
        authorizedAt: new Date().toISOString(),
      },
      scope: oauthReqInfo.scope,
      props: userProps,
    })

    return Response.redirect(redirectTo, 302)
  } catch (error) {
    console.error('[OAUTH] /discogs-callback error:', error)
    return new Response(
      `<html><body><h1>Authentication Failed</h1><p>${error instanceof Error ? error.message : 'Unknown error'}</p><p>Please try again.</p></body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    )
  }
}

async function handleManualLogin(request: Request, env: OAuthEnv): Promise<Response> {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id') ?? crypto.randomUUID()
    const fromMcpClient = !!url.searchParams.get('session_id')

    // Generate CSRF token
    const csrfToken = crypto.randomUUID()

    // Construct Discogs callback URL for the manual path
    const callbackUrl = `${url.protocol}//${url.host}/callback?session_id=${sessionId}`

    // Get Discogs request token
    const discogsAuth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
    const { oauth_token: requestToken, oauth_token_secret: requestTokenSecret } =
      await discogsAuth.getRequestToken(callbackUrl)

    // Single KV write with all fields (CSRF token + Discogs tokens)
    await env.MCP_SESSIONS.put(
      `login-pending:${sessionId}`,
      JSON.stringify({
        sessionId,
        csrfToken,
        requestToken,
        requestTokenSecret,
        fromMcpClient,
        timestamp: Date.now(),
      }),
      { expirationTtl: 600 }, // 10 minutes
    )

    // Use __Host- prefix on HTTPS, plain on HTTP (local dev)
    const isHttps = url.protocol === 'https:'
    const cookieName = isHttps ? '__Host-csrf' : 'csrf'
    const cookieFlags = isHttps
      ? `${cookieName}=${csrfToken}; HttpOnly; Secure; SameSite=Lax; Path=/`
      : `${cookieName}=${csrfToken}; HttpOnly; SameSite=Lax; Path=/`

    const authorizeUrl = `https://www.discogs.com/oauth/authorize?oauth_token=${requestToken}`

    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl,
        'Set-Cookie': cookieFlags,
      },
    })
  } catch (error) {
    console.error('[LOGIN] /login error:', error)
    return new Response(
      `Login error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { status: 500 },
    )
  }
}

async function handleManualCallback(request: Request, env: OAuthEnv): Promise<Response> {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id')
    const oauthToken = url.searchParams.get('oauth_token')
    const oauthVerifier = url.searchParams.get('oauth_verifier')

    if (!sessionId || !oauthToken || !oauthVerifier) {
      return new Response('Missing required parameters', { status: 400 })
    }

    // Look up the pending login
    const pendingKey = `login-pending:${sessionId}`
    const pendingDataStr = await env.MCP_SESSIONS.get(pendingKey)

    if (!pendingDataStr) {
      return new Response(
        '<html><body><h1>Session Expired</h1><p>Your login session has expired. Please try again.</p></body></html>',
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      )
    }

    const pendingData = JSON.parse(pendingDataStr)

    // Validate CSRF token from cookie
    const isHttps = url.protocol === 'https:'
    const cookieName = isHttps ? '__Host-csrf' : 'csrf'
    const cookieHeader = request.headers.get('Cookie') ?? ''
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=')
        return [k, v.join('=')]
      }),
    )
    const csrfFromCookie = cookies[cookieName]

    if (!csrfFromCookie || csrfFromCookie !== pendingData.csrfToken) {
      await env.MCP_SESSIONS.delete(pendingKey)
      return new Response('CSRF validation failed. Please try logging in again.', { status: 403 })
    }

    // Clean up pending entry
    await env.MCP_SESSIONS.delete(pendingKey)

    // Exchange tokens
    const discogsAuth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
    const { oauth_token: accessToken, oauth_token_secret: accessTokenSecret } =
      await discogsAuth.getAccessToken(oauthToken, pendingData.requestTokenSecret, oauthVerifier)

    // Fetch identity
    const identityRes = await fetch('https://api.discogs.com/oauth/identity', {
      headers: {
        Authorization: (
          await discogsAuth.getAuthHeaders('https://api.discogs.com/oauth/identity', 'GET', {
            key: accessToken,
            secret: accessTokenSecret,
          })
        ).Authorization,
        'User-Agent': 'discogs-mcp/1.0.0',
      },
    })

    if (!identityRes.ok) {
      throw new Error(`Failed to fetch Discogs identity: ${identityRes.status}`)
    }

    const identity = await identityRes.json() as { id: number; username: string }

    // Allowlist gate (set on maintainer's deployment; empty = open)
    const denied = await checkAllowlist(
      identity,
      env.ALLOWED_DISCOGS_USER_ID,
      env.ALLOWED_DISCOGS_USERNAMES,
      env.MCP_SESSIONS,
    )
    if (denied) return denied

    // Store session in KV (7 days)
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({
        numericId: String(identity.id),
        username: identity.username,
        accessToken,
        accessTokenSecret,
        timestamp: Date.now(),
        expiresAt,
        sessionId,
      }),
      { expirationTtl: 7 * 24 * 60 * 60 },
    )

    // Mirror the access token under a userId-keyed entry so the cron handler
    // (which has no request context) can sync the user's collection in the background.
    // No TTL — the mirror should outlive sessions so the cron keeps working
    // even if the user hasn't opened an MCP client recently.
    await env.MCP_SESSIONS.put(
      tokenMirrorKey(String(identity.id)),
      JSON.stringify({
        numericId: String(identity.id),
        username: identity.username,
        accessToken,
        accessTokenSecret,
      }),
    )

    const fromMcpClient = !!pendingData.fromMcpClient
    const instructionsHtml = fromMcpClient
      ? `<p>Your MCP session is now connected. You can close this window.</p>`
      : `<p>Use this URL in your MCP client: <code>${url.protocol}//${url.host}/mcp?session_id=${sessionId}</code></p>`

    return new Response(
      `<!DOCTYPE html><html><body>
        <h1>Authentication Successful!</h1>
        <p>You're now authenticated as <strong>${identity.username}</strong> on Discogs.</p>
        ${instructionsHtml}
      </body></html>`,
      {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Set-Cookie': `${cookieName}=; Max-Age=0; Path=/`,
        },
      },
    )
  } catch (error) {
    console.error('[LOGIN] /callback error:', error)
    return new Response(
      `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { status: 500 },
    )
  }
}

function handleProtectedResourceMetadata(request: Request): Response {
  const url = new URL(request.url)
  const baseUrl = `${url.protocol}//${url.host}`

  return new Response(
    JSON.stringify({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: [],
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    },
  )
}
