/**
 * Public tools - available without authentication
 * These tools can be called by anyone and don't require Discogs authentication
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Env } from '../../types/env.js'
import type { SessionContext } from '../server.js'
import { buildNextSteps } from '../../utils/breadcrumb.js'
import { describeRelayStatus, type RelayStatus } from '../../rate-limiter/relay.js'
import { SERVER_VERSION } from '../../version.js'

/**
 * Generate authentication URL with connection ID if available
 */
function getAuthUrl(connectionId?: string): string {
	const baseUrl = 'https://discogs-mcp.com'
	return connectionId ? `${baseUrl}/login?connection_id=${connectionId}` : `${baseUrl}/login`
}

/**
 * Ask the rate limiter how Discogs traffic is leaving right now. The relay
 * falls back to direct calls without any change to tool results, so this line
 * in ping / server_info is how a user learns the relay host is down. Never
 * throws: a limiter that can't be reached is reported as such.
 */
async function relayStatusLine(env: Env): Promise<string> {
	try {
		const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('discogs-rate-limiter'))
		const res = await stub.fetch(new Request('http://do/state'))
		const state = (await res.json()) as { relay?: RelayStatus }
		return describeRelayStatus(state.relay ?? null, Date.now())
	} catch {
		return describeRelayStatus(null, Date.now())
	}
}

/**
 * Register all public tools that don't require authentication
 */
export function registerPublicTools(server: McpServer, env: Env, getSessionContext: () => Promise<SessionContext>): void {
	// Ping tool - simple connectivity test
	server.tool(
		'ping',
		'Test connectivity to the Discogs MCP server',
		{
			message: z.string().optional().default('Hello from Discogs MCP!').describe('Message to echo back'),
		},
		async ({ message }) => {
			const egress = await relayStatusLine(env)
			const nextSteps = buildNextSteps([
				{ tool: 'server_info', args: '', hint: 'see server version and feature list' },
				{ tool: 'auth_status', args: '', hint: 'check whether you are authenticated' },
			])
			return {
				content: [
					{
						type: 'text',
						text: `Pong! You said: ${message}\n${egress}${nextSteps}`,
					},
				],
			}
		},
	)

	// Server info tool - get server details
	server.tool('server_info', 'Get information about the Discogs MCP server', {}, async () => {
		const { connectionId } = await getSessionContext()
		const authUrl = getAuthUrl(connectionId)
		const egress = await relayStatusLine(env)

		const nextSteps = buildNextSteps([
			{ tool: 'auth_status', args: '', hint: 'check whether the current session is authenticated' },
			{ tool: 'ping', args: '', hint: 'test connectivity' },
		])

		return {
			content: [
				{
					type: 'text',
					text: `Discogs MCP Server v${SERVER_VERSION}\n\nStatus: Running\nProtocol: MCP 2024-11-05\nFeatures:\n- Resources: Collection, Releases, Search\n- Authentication: OAuth 1.0a\n- Rate Limiting: Enabled\n- ${egress}\n\nTo get started, authenticate at ${authUrl}${nextSteps}`,
				},
			],
		}
	})

	// Auth status tool - check authentication status
	server.tool('auth_status', 'Check authentication status and get login instructions if needed', {}, async () => {
		const { session, connectionId } = await getSessionContext()
		const loginUrl = getAuthUrl(connectionId)

		// Check if user is authenticated
		if (session) {
			const nextSteps = buildNextSteps([
				{ tool: 'search_collection', args: 'query="..."', hint: 'free-text ranked search of your collection' },
				{ tool: 'get_collection_stats', args: '', hint: 'see the shape of your collection' },
				{ tool: 'get_recommendations', args: '', hint: 'personalized picks based on your collection' },
			])
			return {
				content: [
					{
						type: 'text',
						text: `✅ **Authentication Status: Authenticated**

You are successfully authenticated with Discogs!

**Your session:**
- User ID: ${session.userId}
- Session expires: ${new Date(session.exp * 1000).toISOString()}

**Available tools:**

*Search & discovery:* search_collection, search_discogs, get_release, get_collection_stats, get_recommendations
*Collection management:* add_to_collection, remove_from_collection, move_release, rate_release
*Folders:* list_folders, create_folder, edit_folder, delete_folder
*Custom fields:* list_custom_fields, edit_custom_field
*Diagnostics:* get_cache_stats${nextSteps}`,
					},
				],
			}
		}

		// Not authenticated
		return {
			content: [
				{
					type: 'text',
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
		}
	})
}
