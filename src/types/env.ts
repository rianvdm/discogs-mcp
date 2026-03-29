/**
 * Environment variables and bindings for the Cloudflare Worker
 */
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {
  // Discogs OAuth credentials
  DISCOGS_CONSUMER_KEY: string
  DISCOGS_CONSUMER_SECRET: string

  // JWT secret for legacy session-based handler (src/index.ts)
  JWT_SECRET: string

  // OAuth provider helpers (injected by @cloudflare/workers-oauth-provider at runtime)
  OAUTH_PROVIDER: OAuthHelpers

  // KV namespaces for logging and sessions
  MCP_LOGS: KVNamespace
  MCP_SESSIONS: KVNamespace

  // KV namespace for OAuth provider state (tokens, grants, client registrations)
  OAUTH_KV: KVNamespace

  // Durable Object namespace for Discogs API rate limiting
  RATE_LIMITER: DurableObjectNamespace
}
