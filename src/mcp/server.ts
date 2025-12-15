/**
 * MCP Server configuration for Discogs
 * Uses the official @modelcontextprotocol/sdk with Cloudflare Agents SDK
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../types/env.js";
import { registerPublicTools } from "./tools/public.js";
import { registerAuthenticatedTools } from "./tools/authenticated.js";
import { registerResources } from "./resources/discogs.js";
import { registerPrompts } from "./prompts/collection.js";
import { verifySessionToken, type SessionPayload } from "../auth/jwt.js";

/**
 * Session context - extracted from request for tool access
 */
export interface SessionContext {
	session: SessionPayload | null;
	connectionId?: string;
}

/**
 * Extract session from request (cookies or connection-specific storage)
 */
async function extractSessionFromRequest(
	request: Request,
	env: Env
): Promise<SessionContext> {
	const connectionId = request.headers.get("X-Connection-ID") || undefined;

	// Try to get session from cookie
	try {
		const cookieHeader = request.headers.get("Cookie");
		if (cookieHeader) {
			const cookies = cookieHeader.split(";").reduce(
				(acc, cookie) => {
					const [key, value] = cookie.trim().split("=");
					if (key && value) {
						acc[key] = value;
					}
					return acc;
				},
				{} as Record<string, string>
			);

			const sessionToken = cookies.session;
			if (sessionToken) {
				const session = await verifySessionToken(sessionToken, env.JWT_SECRET);
				if (session) {
					return { session, connectionId };
				}
			}
		}
	} catch (error) {
		console.error("Error verifying cookie session:", error);
	}

	// Try connection-specific authentication if we have KV storage
	if (connectionId && env.MCP_SESSIONS) {
		try {
			// For mcp-remote connections, skip SSE connection check
			// mcp-remote uses deterministic connection IDs
			const sessionDataStr = await env.MCP_SESSIONS.get(
				`session:${connectionId}`
			);
			if (sessionDataStr) {
				const sessionData = JSON.parse(sessionDataStr);

				// Verify the stored session is still valid
				if (
					!sessionData.expiresAt ||
					new Date(sessionData.expiresAt) <= new Date()
				) {
					console.log("Connection session has expired");
					return { session: null, connectionId };
				}

				// Return session payload
				const session: SessionPayload = {
					userId: sessionData.userId,
					accessToken: sessionData.accessToken,
					accessTokenSecret: sessionData.accessTokenSecret,
					iat: Math.floor(Date.now() / 1000),
					exp: Math.floor(new Date(sessionData.expiresAt).getTime() / 1000),
				};

				return { session, connectionId };
			}
		} catch (error) {
			console.error("Error retrieving connection session:", error);
		}
	}

	return { session: null, connectionId };
}

/**
 * Creates and configures the MCP server with all tools, resources, and prompts
 * Uses factory pattern to provide env and request context access via closures
 */
export function createServer(env: Env, request: Request): McpServer {
	const server = new McpServer({
		name: "discogs-mcp",
		version: "1.0.0",
	});

	// Create a session context holder that will be populated lazily
	let sessionContextCache: SessionContext | null = null;
	let sessionContextPromise: Promise<SessionContext> | null = null;

	// Lazy session extraction - only extract session when first tool is called
	const getSessionContext = (): SessionContext => {
		// If we've already extracted session, return it immediately
		if (sessionContextCache) {
			return sessionContextCache;
		}

		// If extraction is in progress, this is an error (tools should await)
		// But we'll handle it gracefully by returning unauthenticated
		console.warn(
			"Session context accessed before extraction complete - returning unauthenticated"
		);
		return { session: null, connectionId: undefined };
	};

	// Initialize session extraction (async, happens before tools are called)
	sessionContextPromise = extractSessionFromRequest(request, env).then(
		(context) => {
			sessionContextCache = context;
			return context;
		}
	);

	// Ensure session is extracted before server handles any requests
	// The MCP handler will await this internally
	(server as any)._sessionPromise = sessionContextPromise;

	// Register public tools (available without authentication)
	registerPublicTools(server, env);

	// Register authenticated tools with session context provider
	registerAuthenticatedTools(server, env, getSessionContext);

	// Register resources (require authentication)
	registerResources(server, env, getSessionContext);

	// Register prompts (common workflows)
	registerPrompts(server);

	return server;
}
