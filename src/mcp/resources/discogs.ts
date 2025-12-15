import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../../types/env.js";
import { DiscogsClient } from "../../clients/discogs.js";
import { CachedDiscogsClient } from "../../clients/cachedDiscogs.js";
import type { SessionContext } from "../server.js";

/**
 * Register Discogs resources with the MCP server
 */
export function registerResources(
	server: McpServer,
	env: Env,
	getSessionContext: () => Promise<SessionContext>
): void {
	// Create Discogs clients
	const discogsClient = new DiscogsClient();
	const cachedClient = env.MCP_SESSIONS
		? new CachedDiscogsClient(discogsClient, env.MCP_SESSIONS)
		: null;
	const client = cachedClient || discogsClient;

	// List available resources
	server.registerResource(
		"collection",
		"discogs://collection",
		{
			mimeType: "application/json",
			description: "Complete Discogs collection for the authenticated user",
		},
		async (uri) => {
			const { session } = await getSessionContext();

			if (!session) {
				throw new Error(
					"Authentication required to access collection resource"
				);
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				const collection = await client.searchCollection(
					userProfile.username,
					session.accessToken,
					session.accessTokenSecret,
					{
						per_page: 100, // Start with first 100 items
					},
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: "application/json",
							text: JSON.stringify(collection, null, 2),
						},
					],
				};
			} catch (error) {
				throw new Error(
					`Failed to read collection resource: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		}
	);

	// Release details resource (template)
	server.registerResource(
		"release",
		new ResourceTemplate("discogs://release/{id}", { list: undefined }),
		{
			mimeType: "application/json",
			description: "Detailed information about a specific Discogs release. Replace {id} with the release ID.",
		},
		async (uri, variables) => {
			const { session } = await getSessionContext();

			if (!session) {
				throw new Error("Authentication required to access release resource");
			}

			try {
				const releaseId = variables.id;
				if (!releaseId) {
					throw new Error("Invalid release URI - must specify a release ID");
				}

				const release = await client.getRelease(
					releaseId as string,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: "application/json",
							text: JSON.stringify(release, null, 2),
						},
					],
				};
			} catch (error) {
				throw new Error(
					`Failed to read release resource: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		}
	);

	// Search resource (template with query parameter)
	server.registerResource(
		"search",
		new ResourceTemplate("discogs://search?q={query}", { list: undefined }),
		{
			mimeType: "application/json",
			description: "Search results from user's collection. Replace {query} with search terms.",
		},
		async (uri, variables) => {
			const { session } = await getSessionContext();

			if (!session) {
				throw new Error("Authentication required to access search resource");
			}

			try {
				// We can get query directly from variables now!
				const query = variables.query;

				if (!query) {
					throw new Error("Invalid search URI - query parameter is required");
				}

				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				const searchResults = await client.searchCollection(
					userProfile.username,
					session.accessToken,
					session.accessTokenSecret,
					{
						query: query as string,
						per_page: 50,
					},
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: "application/json",
							text: JSON.stringify(searchResults, null, 2),
						},
					],
				};
			} catch (error) {
				throw new Error(
					`Failed to read search resource: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		}
	);
}
