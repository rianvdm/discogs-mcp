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

  // Optional allowlist by Discogs username (resolved to numeric ID at runtime
  // via GET /users/<name>, cached in MCP_SESSIONS for 7 days).
  // Accepts a single name ("jhuggart") or comma-separated list ("a,b,c").
  // Merged with ALLOWED_DISCOGS_USER_ID. Empty/unset on both = open instance.
  ALLOWED_DISCOGS_USERNAMES?: string

  // Optional debug token for the GET /debug/budget endpoint.
  // If unset, the debug endpoint returns 404 (no surface area exposed).
  // Set via `wrangler secret put DEBUG_TOKEN --env production` with any random string.
  DEBUG_TOKEN?: string

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
