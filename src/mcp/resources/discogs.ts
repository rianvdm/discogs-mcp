import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../../types/env.js'
import { DiscogsClient } from '../../clients/discogs.js'
import { CachedDiscogsClient } from '../../clients/cachedDiscogs.js'
import type { DiscogsCollectionItem } from '../../clients/discogs.js'
import type { SessionContext } from '../server.js'

/**
 * Register Discogs resources with the MCP server
 */
export function registerResources(server: McpServer, env: Env, getSessionContext: () => Promise<SessionContext>): void {
	// Create Discogs clients
	const discogsClient = new DiscogsClient()
	// Set KV for persistent rate limiting across Worker invocations
	if (env.MCP_SESSIONS) {
		discogsClient.setKV(env.MCP_SESSIONS)
	}
	const cachedClient = env.MCP_SESSIONS ? new CachedDiscogsClient(discogsClient, env.MCP_SESSIONS) : null
	const client = cachedClient || discogsClient

	// List available resources
	server.registerResource(
		'collection',
		'discogs://collection',
		{
			mimeType: 'application/json',
			description: 'Complete Discogs collection for the authenticated user',
		},
		async (uri) => {
			const { session } = await getSessionContext()

			if (!session) {
				throw new Error('Authentication required to access collection resource')
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				// Use getCompleteCollection() when cached client is available
				// to return the full collection (not just page 1) and benefit
				// from the shared 45-min cache.
				let collection
				if (cachedClient) {
					collection = await cachedClient.getCompleteCollection(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
					)
				} else {
					collection = await client.searchCollection(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						{ per_page: 100 },
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
					)
				}

				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: 'application/json',
							text: JSON.stringify(collection, null, 2),
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to read collection resource: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	// Release details resource (template)
	server.registerResource(
		'release',
		new ResourceTemplate('discogs://release/{id}', { list: undefined }),
		{
			mimeType: 'application/json',
			description: 'Detailed information about a specific Discogs release. Replace {id} with the release ID.',
		},
		async (uri, variables) => {
			const { session } = await getSessionContext()

			if (!session) {
				throw new Error('Authentication required to access release resource')
			}

			try {
				const releaseId = variables.id
				if (!releaseId) {
					throw new Error('Invalid release URI - must specify a release ID')
				}

				const release = await client.getRelease(
					releaseId as string,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: 'application/json',
							text: JSON.stringify(release, null, 2),
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to read release resource: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	// Search resource (template with query parameter)
	server.registerResource(
		'search',
		new ResourceTemplate('discogs://search?q={query}', { list: undefined }),
		{
			mimeType: 'application/json',
			description: "Search results from user's collection. Replace {query} with search terms.",
		},
		async (uri, variables) => {
			const { session } = await getSessionContext()

			if (!session) {
				throw new Error('Authentication required to access search resource')
			}

			try {
				// We can get query directly from variables now!
				const query = variables.query

				if (!query) {
					throw new Error('Invalid search URI - query parameter is required')
				}

				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				// When cached client is available, search against the cached
				// complete collection instead of triggering a full pagination.
				let searchResults
				if (cachedClient) {
					const allReleases = await cachedClient.getCompleteCollectionReleases(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
					)

					// Simple in-memory search filter
					const queryLower = (query as string).toLowerCase()
					const filtered = allReleases
						.filter((item: DiscogsCollectionItem) => {
							const info = item.basic_information
							const searchable = [...(info.artists?.map((a) => a.name) || []), info.title, ...(info.genres || []), ...(info.styles || [])]
								.join(' ')
								.toLowerCase()
							return searchable.includes(queryLower)
						})
						.slice(0, 50)

					searchResults = {
						pagination: {
							pages: 1,
							page: 1,
							per_page: filtered.length,
							items: filtered.length,
							urls: {},
						},
						releases: filtered,
					}
				} else {
					searchResults = await client.searchCollection(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						{
							query: query as string,
							per_page: 50,
						},
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
					)
				}

				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: 'application/json',
							text: JSON.stringify(searchResults, null, 2),
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to read search resource: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)
}
