/**
 * Environment variables and bindings for the Cloudflare Worker
 */
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {
  // Discogs OAuth credentials
  DISCOGS_CONSUMER_KEY: string
  DISCOGS_CONSUMER_SECRET: string

  // Optional allowlist: numeric Discogs user ID(s) permitted to authenticate.
  // Accepts a single ID ("123456") or a comma-separated list ("123,456,789").
  // Empty / unset = no allowlist (open instance, for self-hosters and local dev).
  ALLOWED_DISCOGS_USER_ID?: string

  // Optional debug token for the GET /debug/budget endpoint.
  // If unset, the debug endpoint returns 404 (no surface area exposed).
  // Set via `wrangler secret put DEBUG_TOKEN --env production` with any random string.
  DEBUG_TOKEN?: string

  // Optional egress relay for Discogs API calls (see src/rate-limiter/relay.ts).
  // Discogs throttles per source IP and Workers share Cloudflare's egress IPs, so
  // the hosted instance sends its calls through a Cloudflare Tunnel to a machine
  // with an IP of its own. DISCOGS_RELAY_ORIGIN is a plain var (e.g.
  // "https://relay.discogs-mcp.com"); the two RELAY_ACCESS_* values are the
  // Cloudflare Access service token that guards it, set via `wrangler secret put`.
  // Leave all three unset to call api.discogs.com directly (self-hosters, local dev).
  DISCOGS_RELAY_ORIGIN?: string
  RELAY_ACCESS_CLIENT_ID?: string
  RELAY_ACCESS_CLIENT_SECRET?: string

  // JWT secret for legacy session-based handler (src/index.ts)
  JWT_SECRET: string

  // OAuth provider helpers (injected by @cloudflare/workers-oauth-provider at runtime)
  OAUTH_PROVIDER: OAuthHelpers

  // KV namespace for sessions
  MCP_SESSIONS: KVNamespace

  // KV namespace for OAuth provider state (tokens, grants, client registrations)
  OAUTH_KV: KVNamespace

  // Durable Object namespace for Discogs API rate limiting
  RATE_LIMITER: DurableObjectNamespace
}
