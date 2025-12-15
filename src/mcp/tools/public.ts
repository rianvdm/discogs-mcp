/**
 * Public tools - available without authentication
 * These tools can be called by anyone and don't require Discogs authentication
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../../types/env.js";
import { verifySessionToken, type SessionPayload } from "../../auth/jwt.js";
import { discogsClient } from "../../clients/discogs.js";

/**
 * Get session from request headers/cookies
 */
async function getSession(
	request: Request,
	env: Env
): Promise<SessionPayload | null> {
	try {
		// Get session cookie
		const cookieHeader = request.headers.get("Cookie");
		if (!cookieHeader) {
			return null;
		}

		// Parse cookies
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
		if (!sessionToken) {
			return null;
		}

		// Verify JWT token
		return await verifySessionToken(sessionToken, env.JWT_SECRET);
	} catch (error) {
		console.error("Session verification error:", error);
		return null;
	}
}

/**
 * Get authentication URL for the user
 */
function getAuthUrl(request: Request): string {
	const connectionId = request.headers.get("X-Connection-ID");
	const baseUrl = "https://discogs-mcp-prod.rian-db8.workers.dev";
	return connectionId
		? `${baseUrl}/login?connection_id=${connectionId}`
		: `${baseUrl}/login`;
}

/**
 * Register all public tools that don't require authentication
 */
export function registerPublicTools(server: McpServer, env: Env): void {
	// Ping tool - simple connectivity test
	server.tool(
		"ping",
		"Test connectivity to the Discogs MCP server",
		{
			message: z
				.string()
				.optional()
				.default("Hello from Discogs MCP!")
				.describe("Message to echo back"),
		},
		async ({ message }) => {
			return {
				content: [
					{
						type: "text",
						text: `Pong! You said: ${message}`,
					},
				],
			};
		}
	);

	// Server info tool - get server details
	server.tool(
		"server_info",
		"Get information about the Discogs MCP server",
		{},
		async () => {
			const authUrl = "https://discogs-mcp-prod.rian-db8.workers.dev/login";

			return {
				content: [
					{
						type: "text",
						text: `Discogs MCP Server v1.0.0\n\nStatus: Running\nProtocol: MCP 2024-11-05\nFeatures:\n- Resources: Collection, Releases, Search\n- Authentication: OAuth 1.0a\n- Rate Limiting: Enabled\n\nTo get started, authenticate at ${authUrl}`,
					},
				],
			};
		}
	);

	// Auth status tool - check authentication status
	server.tool(
		"auth_status",
		"Check authentication status and get login instructions if needed",
		{},
		async () => {
			const loginUrl = "https://discogs-mcp-prod.rian-db8.workers.dev/login";

			// For now, always return unauthenticated status
			// TODO: Implement session management with SDK context
			return {
				content: [
					{
						type: "text",
						text: `🔐 **Authentication Status: Not Authenticated**

You are not currently authenticated with Discogs. To access your personal music collection, you need to authenticate first.

**How to authenticate:**
1. Visit: ${loginUrl}
2. Sign in with your Discogs account
3. Authorize access to your collection
4. Return here and try your query again

**Available without authentication:**
- ping: Test server connectivity
- server_info: Get server information

**Requires authentication:**
- search_collection: Search your music collection
- get_release: Get release details
- get_collection_stats: View collection statistics
- get_recommendations: Get personalized recommendations
- get_recent_activity: View recent collection activity
- get_cache_stats: View cache performance`,
					},
				],
			};
		}
	);
}
