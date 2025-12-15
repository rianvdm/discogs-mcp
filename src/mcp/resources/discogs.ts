/**
 * Discogs Resources
 * Provides MCP resources for accessing Discogs data via URIs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
	server.resource(
		"discogs://collection",
		"Complete Discogs collection for the authenticated user",
		"application/json",
		async () => {
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
							uri: "discogs://collection",
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
	server.resource(
		"discogs://release/{id}",
		"Detailed information about a specific Discogs release. Replace {id} with the release ID.",
		"application/json",
		async (uri: string) => {
			const { session } = await getSessionContext();

			if (!session) {
				throw new Error("Authentication required to access release resource");
			}

			try {
				// Extract release ID from URI
				const releaseId = uri.replace("discogs://release/", "");
				if (!releaseId || releaseId.includes("{")) {
					throw new Error("Invalid release URI - must specify a release ID");
				}

				const release = await client.getRelease(
					releaseId,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				return {
					contents: [
						{
							uri,
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
	server.resource(
		"discogs://search?q={query}",
		"Search results from user's collection. Replace {query} with search terms.",
		"application/json",
		async (uri: string) => {
			const { session } = await getSessionContext();

			if (!session) {
				throw new Error("Authentication required to access search resource");
			}

			try {
				// Parse query parameter from URI
				const url = new URL(uri.replace("discogs://", "https://example.com/"));
				const query = url.searchParams.get("q");

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
						query,
						per_page: 50,
					},
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				return {
					contents: [
						{
							uri,
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
