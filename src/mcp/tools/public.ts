/**
 * Public tools - available without authentication
 * These tools can be called by anyone and don't require Discogs authentication
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../../types/env.js";
import type { SessionContext } from "../server.js";

/**
 * Generate authentication URL with connection ID if available
 */
function getAuthUrl(connectionId?: string): string {
	const baseUrl = "https://discogs-mcp-prod.rian-db8.workers.dev";
	return connectionId
		? `${baseUrl}/login?connection_id=${connectionId}`
		: `${baseUrl}/login`;
}

/**
 * Register all public tools that don't require authentication
 */
export function registerPublicTools(
	server: McpServer,
	env: Env,
	getSessionContext: () => Promise<SessionContext>
): void {
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
			const { connectionId } = await getSessionContext();
			const authUrl = getAuthUrl(connectionId);

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
			const { session, connectionId } = await getSessionContext();
			const loginUrl = getAuthUrl(connectionId);

			// Check if user is authenticated
			if (session) {
				return {
					content: [
						{
							type: "text",
							text: `✅ **Authentication Status: Authenticated**

You are successfully authenticated with Discogs!

**Your session:**
- User ID: ${session.userId}
- Session expires: ${new Date(session.exp * 1000).toISOString()}

**Available tools:**
- search_collection: Search your music collection
- get_release: Get release details
- get_collection_stats: View collection statistics
- get_recommendations: Get personalized recommendations
- get_cache_stats: View cache performance`,
						},
					],
				};
			}

			// Not authenticated
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
- get_cache_stats: View cache performance`,
					},
				],
			};
		}
	);
}
