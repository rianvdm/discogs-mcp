/**
 * MCP Server factory for Discogs
 * Returns { server, setContext } so both OAuth and session paths can inject auth props.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types/env.js'
import { registerPublicTools } from './tools/public.js'
import { registerAuthenticatedTools } from './tools/authenticated.js'
import { registerResources } from './resources/discogs.js'
import { registerPrompts } from './prompts/collection.js'

/**
 * Session payload compatible with tool expectations.
 * Maps Discogs credentials to tool access patterns.
 */
export interface SessionPayload {
  userId: string
  username: string
  numericId: string
  accessToken: string
  accessTokenSecret: string
  iat: number
  exp: number
}

/**
 * Auth session — Discogs credentials available to tools after authentication.
 */
export interface DiscogsSession {
  username: string
  numericId: string
  accessToken: string
  accessTokenSecret: string
}

/**
 * Per-request context — mutable, updated before each MCP handler call.
 */
export interface McpRequestContext {
  session: DiscogsSession | null
  sessionId: string | null
  baseUrl: string
}

/**
 * Session context shape consumed by tool files.
 * Uses SessionPayload so existing tool code (session.userId, session.exp, etc.) compiles unchanged.
 */
export interface SessionContext {
  session: SessionPayload | null
  connectionId?: string
}

export interface McpServerWithContext {
  server: McpServer
  setContext: (ctx: Partial<McpRequestContext>) => void
  getContext: () => McpRequestContext
}

/**
 * Creates and configures the MCP server.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param baseUrl - Base URL for constructing auth URLs (e.g. https://host)
 */
export function createMcpServer(env: Env, baseUrl: string): McpServerWithContext {
  const server = new McpServer({
    name: 'discogs-mcp',
    version: '1.0.0',
  })

  // Mutable context — set by the caller before the MCP handler runs
  const context: McpRequestContext = {
    session: null,
    sessionId: null,
    baseUrl,
  }

  // Adapt DiscogsSession -> SessionPayload for backward-compatible tool access
  const getSessionContext = async (): Promise<SessionContext> => {
    if (!context.session) {
      return { session: null, connectionId: context.sessionId ?? undefined }
    }
    const { username, numericId, accessToken, accessTokenSecret } = context.session
    const sessionPayload: SessionPayload = {
      userId: username,
      username,
      numericId,
      accessToken,
      accessTokenSecret,
      iat: 0,
      exp: 0,
    }
    return { session: sessionPayload, connectionId: context.sessionId ?? undefined }
  }

  // Register all tools and resources
  registerPublicTools(server, env, getSessionContext)
  registerAuthenticatedTools(server, env, getSessionContext)
  registerResources(server, env, getSessionContext)
  registerPrompts(server)

  return {
    server,
    setContext: (ctx: Partial<McpRequestContext>) => {
      if (ctx.session !== undefined) context.session = ctx.session
      if (ctx.sessionId !== undefined) context.sessionId = ctx.sessionId
      if (ctx.baseUrl !== undefined) context.baseUrl = ctx.baseUrl
    },
    getContext: () => ({ ...context }),
  }
}
