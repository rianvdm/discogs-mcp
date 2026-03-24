/**
 * Authenticated tools - require Discogs OAuth authentication
 * These tools can only be called after the user has authenticated via OAuth 1.0a
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Env } from '../../types/env.js'

import { DiscogsClient } from '../../clients/discogs.js'
import { CachedDiscogsClient } from '../../clients/cachedDiscogs.js'
import { analyzeMoodQuery, hasMoodContent, generateMoodSearchTerms } from '../../utils/moodMapping.js'
import type { DiscogsCollectionItem } from '../../clients/discogs.js'
import type { SessionContext } from '../server.js'

/**
 * Type for release with relevance score
 */
type ReleaseWithRelevance = DiscogsCollectionItem & { relevanceScore?: number }

/**
 * Filter an array of releases in-memory using the same logic as
 * DiscogsClient.searchCollectionWithQuery(), but without any API calls.
 *
 * This enables the "fetch once, filter many" optimization: the complete
 * collection is fetched and cached once, then all query variants (original
 * + mood expansions) are run as pure in-memory filters against that dataset.
 */
function filterReleasesInMemory(
	allReleases: DiscogsCollectionItem[],
	query: string,
	_options: {
		hasRecent?: boolean
		hasOld?: boolean
		sort?: 'added' | 'artist' | 'title' | 'year'
		sortOrder?: 'asc' | 'desc'
	} = {},
): DiscogsCollectionItem[] {
	// Extract temporal terms that should affect sorting rather than filtering
	const temporalTerms = ['recent', 'recently', 'new', 'newest', 'latest', 'old', 'oldest', 'earliest']
	const queryWords = query.toLowerCase().split(/\s+/)

	// Remove temporal terms from the actual search query
	const filteredQuery = queryWords.filter((word) => !temporalTerms.includes(word)).join(' ')

	if (!filteredQuery.trim()) {
		// No actual search terms after removing temporal terms -- return all releases
		return [...allReleases]
	}

	// Apply the same filtering logic as searchCollectionWithQuery
	const filteredReleases = allReleases.filter((item) => {
		const release = item.basic_information

		// For single word queries or exact ID searches, use simple includes
		if (!filteredQuery.includes(' ') || /^\d+$/.test(filteredQuery)) {
			const releaseIdMatch = item.id.toString().includes(filteredQuery) || release.id.toString().includes(filteredQuery)
			const artistMatch = release.artists?.some((artist) => artist.name.toLowerCase().includes(filteredQuery)) || false
			const titleMatch = release.title?.toLowerCase().includes(filteredQuery) || false
			const genreMatch = release.genres?.some((genre) => genre.toLowerCase().includes(filteredQuery)) || false
			const styleMatch = release.styles?.some((style) => style.toLowerCase().includes(filteredQuery)) || false
			const labelMatch =
				release.labels?.some(
					(label) => label.name.toLowerCase().includes(filteredQuery) || label.catno.toLowerCase().includes(filteredQuery),
				) || false
			const formatMatch = release.formats?.some((format) => format.name.toLowerCase().includes(filteredQuery)) || false

			let yearMatch = false
			if (release.year) {
				const yearStr = release.year.toString()
				if (yearStr.includes(filteredQuery)) yearMatch = true
				const decadeMatch = filteredQuery.match(/(\d{4})s$/)
				if (decadeMatch) {
					const startDecade = parseInt(decadeMatch[1])
					if (release.year >= startDecade && release.year < startDecade + 10) yearMatch = true
				}
			}

			return releaseIdMatch || artistMatch || titleMatch || genreMatch || styleMatch || labelMatch || formatMatch || yearMatch
		}

		// Multi-word queries: smart matching logic
		const queryTerms = filteredQuery.split(/\s+/).filter((term) => term.length > 2)

		const decadeTerms: string[] = []
		const nonDecadeTerms: string[] = []
		queryTerms.forEach((term) => {
			if (term.match(/^(\d{4})s$/)) {
				decadeTerms.push(term)
			} else {
				nonDecadeTerms.push(term)
			}
		})

		const searchableFields = [
			...(release.artists?.map((artist) => artist.name) || []),
			release.title,
			...(release.genres || []),
			...(release.styles || []),
			...(release.labels?.map((label) => label.name) || []),
			...(release.labels?.map((label) => label.catno) || []),
			...(release.formats?.map((format) => format.name) || []),
			release.year?.toString() || '',
			item.id.toString(),
			release.id.toString(),
		]
		if (release.year) {
			searchableFields.push(`${Math.floor(release.year / 10) * 10}s`)
		}
		const searchableText = searchableFields.join(' ').toLowerCase()

		// Determine matching strategy based on query type
		const genreStyleTerms = [
			'ambient',
			'drone',
			'progressive',
			'rock',
			'jazz',
			'blues',
			'electronic',
			'techno',
			'house',
			'metal',
			'punk',
			'folk',
			'country',
			'classical',
			'hip',
			'hop',
			'rap',
			'soul',
			'funk',
			'disco',
			'reggae',
			'ska',
			'indie',
			'alternative',
			'psychedelic',
			'experimental',
			'avant-garde',
			'minimal',
			'downtempo',
			'chillout',
			'trance',
			'dubstep',
			'garage',
			'post-rock',
			'post-punk',
			'new wave',
			'synthpop',
			'industrial',
			'gothic',
			'darkwave',
			'shoegaze',
			'grunge',
			'hardcore',
		]

		const isMoodQuery = hasMoodContent(filteredQuery)
		const isGenreStyleQuery = nonDecadeTerms.some(
			(term) =>
				genreStyleTerms.includes(term.toLowerCase()) ||
				release.genres?.some((g) => g.toLowerCase().includes(term.toLowerCase())) ||
				release.styles?.some((s) => s.toLowerCase().includes(term.toLowerCase())),
		)

		let nonDecadeMatch = false
		if (nonDecadeTerms.length === 0) {
			nonDecadeMatch = true
		} else if (isGenreStyleQuery || isMoodQuery) {
			if (isMoodQuery) {
				const moodAnalysis = analyzeMoodQuery(filteredQuery)
				if (moodAnalysis.confidence >= 0.3) {
					const releaseGenres = release.genres?.map((g) => g.toLowerCase()) || []
					const releaseStyles = release.styles?.map((s) => s.toLowerCase()) || []
					const suggestedGenres = moodAnalysis.suggestedGenres.map((g) => g.toLowerCase())
					const suggestedStyles = moodAnalysis.suggestedStyles.map((s) => s.toLowerCase())

					const moodMatch =
						releaseGenres.some((rg) => suggestedGenres.some((sg) => rg.includes(sg) || sg.includes(rg))) ||
						releaseStyles.some((rs) => suggestedStyles.some((ss) => rs.includes(ss) || ss.includes(rs)))
					const termMatch = nonDecadeTerms.some((term) => searchableText.includes(term))
					nonDecadeMatch = moodMatch || termMatch
				} else {
					nonDecadeMatch = nonDecadeTerms.some((term) => searchableText.includes(term))
				}
			} else {
				nonDecadeMatch = nonDecadeTerms.some((term) => searchableText.includes(term))
			}
		} else {
			nonDecadeMatch = nonDecadeTerms.every((term) => searchableText.includes(term))
		}

		const decadeMatch =
			decadeTerms.length === 0 ||
			decadeTerms.some((term) => {
				if (searchableText.includes(term)) return true
				const decadeYear = parseInt(term.replace('s', ''))
				return release.year && release.year >= decadeYear && release.year < decadeYear + 10
			})

		return nonDecadeMatch && decadeMatch
	})

	return filteredReleases
}

/**
 * Get authentication instructions for unauthenticated requests
 */
function generateAuthInstructions(connectionId?: string): string {
	const baseUrl = 'https://discogs-mcp.com'
	const loginUrl = connectionId ? `${baseUrl}/login?connection_id=${connectionId}` : `${baseUrl}/login`

	return `🔐 **Authentication Required**

You need to authenticate with Discogs to use this tool.

**How to authenticate:**
1. Visit: ${loginUrl}
2. Sign in with your Discogs account
3. Authorize access to your collection
4. Return here and try again

Your authentication will be secure and tied to your specific session.`
}

/**
 * Register all authenticated tools that require Discogs OAuth
 */
export function registerAuthenticatedTools(server: McpServer, env: Env, getSessionContext: () => Promise<SessionContext>): void {
	// Create Discogs clients
	const discogsClient = new DiscogsClient()
	// Set KV for persistent rate limiting across Worker invocations
	if (env.MCP_SESSIONS) {
		discogsClient.setKV(env.MCP_SESSIONS)
	}
	const cachedClient = env.MCP_SESSIONS ? new CachedDiscogsClient(discogsClient, env.MCP_SESSIONS) : null
	const client = cachedClient || discogsClient

	/**
	 * Tool: search_collection
	 * Search user's Discogs collection with mood-aware queries
	 */
	/**
	 * Detect whether a query is semantic/conceptual (needs LLM interpretation)
	 * vs a literal/specific search (artist name, album title, genre, year).
	 *
	 * Semantic queries describe qualities, feelings, or concepts that don't map
	 * directly to metadata fields — e.g., "empowering female voice", "road trip
	 * through the desert", "albums my dad would love".
	 */
	function isSemanticQuery(query: string, allReleases: DiscogsCollectionItem[]): boolean {
		const q = query.toLowerCase().trim()

		// Single word or numeric — always literal
		if (!q.includes(' ') || /^\d+$/.test(q)) {
			return false
		}

		// If the query matches an artist name in the collection, it's literal
		const matchesArtist = allReleases.some((item) =>
			item.basic_information.artists?.some((a) => {
				const name = a.name.toLowerCase()
				return name.includes(q) || q.includes(name)
			}),
		)
		if (matchesArtist) return false

		// If the query matches an album title in the collection, it's literal
		const matchesTitle = allReleases.some((item) => {
			const title = item.basic_information.title?.toLowerCase() || ''
			return title.includes(q) || q.includes(title)
		})
		if (matchesTitle) return false

		// Known music-specific terms that indicate a concrete/literal search
		const concreteTerms = new Set([
			'rock',
			'jazz',
			'blues',
			'electronic',
			'techno',
			'house',
			'metal',
			'punk',
			'folk',
			'country',
			'classical',
			'hip-hop',
			'rap',
			'soul',
			'funk',
			'disco',
			'reggae',
			'ska',
			'indie',
			'alternative',
			'psychedelic',
			'experimental',
			'ambient',
			'downtempo',
			'trance',
			'dubstep',
			'garage',
			'post-rock',
			'post-punk',
			'new wave',
			'synthpop',
			'industrial',
			'gothic',
			'shoegaze',
			'grunge',
			'hardcore',
			'r&b',
			'pop',
			'latin',
			'world',
			'soundtrack',
			'vinyl',
			'cd',
			'cassette',
			'7"',
			'12"',
			'lp',
		])

		// If ALL non-trivial words are concrete music/format terms, it's literal
		const words = q.split(/\s+/).filter((w) => w.length > 2)
		const allConcrete =
			words.length > 0 &&
			words.every((w) => {
				// Check concrete terms, decade patterns, temporal terms
				return (
					concreteTerms.has(w) ||
					/^\d{4}s?$/.test(w) ||
					['recent', 'recently', 'new', 'newest', 'latest', 'old', 'oldest', 'earliest'].includes(w)
				)
			})
		if (allConcrete) return false

		// If mood mapping has high confidence, the existing pipeline handles it
		if (hasMoodContent(q)) {
			const moodAnalysis = analyzeMoodQuery(q)
			if (moodAnalysis.confidence >= 0.6) {
				return false
			}
		}

		// Otherwise, it's likely a semantic/conceptual query
		return true
	}

	/**
	 * Format the full collection compactly so the calling LLM can apply its
	 * world knowledge to select semantically matching releases.
	 */
	function formatCollectionForSemanticSearch(
		allReleases: DiscogsCollectionItem[],
		query: string,
	): { content: Array<{ type: 'text'; text: string }> } {
		const compactList = allReleases
			.map((release) => {
				const info = release.basic_information
				const artists = info.artists.map((a) => a.name).join(', ')
				const genres = info.genres?.join(', ') || ''
				const styles = info.styles?.length ? ` | ${info.styles.join(', ')}` : ''
				const rating = release.rating > 0 ? ` ★${release.rating}` : ''
				return `[${info.id}] ${artists} - ${info.title} (${info.year}) | ${genres}${styles}${rating}`
			})
			.join('\n')

		return {
			content: [
				{
					type: 'text',
					text:
						`**Semantic search mode:** The collection filter could not find direct matches for "${query}". ` +
						`Below is the complete collection (${allReleases.length} releases). ` +
						`Please use your knowledge of these artists and albums to select the best matches for the user's intent: "${query}"\n\n` +
						`${compactList}\n\n` +
						`**Tip:** Use the release IDs with the get_release tool for detailed information about specific albums.`,
				},
			],
		}
	}

	server.tool(
		'search_collection',
		"Search your Discogs collection with natural language queries. IMPORTANT: Pass the user's query as-is — do NOT rewrite, decompose, or make multiple searches. The tool handles semantic/conceptual queries internally (e.g., 'strong empowering female voice', 'perfect for a rainy Sunday') by returning the full collection for you to select from using your knowledge. Also supports mood descriptors like 'mellow jazz', temporal terms like 'recent' or 'oldest', and specific searches by artist, album, genre, or year. One call is sufficient for any query.",
		{
			query: z
				.string()
				.describe(
					"The user's search query passed verbatim. Do NOT rewrite or decompose the query — pass it exactly as the user said it. The tool handles semantic queries like 'empowering female vocals' or 'road trip music' by returning the full collection for LLM-based selection.",
				),
			per_page: z.number().min(1).max(100).optional().default(50).describe('Number of results to return (1-100)'),
		},
		async ({ query, per_page }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				// Get user profile
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				// Check for temporal terms
				const queryWords = query.toLowerCase().split(/\s+/)
				const hasRecent = queryWords.some((word) => ['recent', 'recently', 'new', 'newest', 'latest'].includes(word))
				const hasOld = queryWords.some((word) => ['old', 'oldest', 'earliest'].includes(word))

				let temporalInfo = ''
				if (hasRecent) {
					temporalInfo = `\n**Search Strategy:** Interpreted "${query}" as searching for items with "recent" meaning "most recently added". Sorting by date added (newest first).\n`
				} else if (hasOld) {
					temporalInfo = `\n**Search Strategy:** Interpreted "${query}" as searching for items with "old/oldest" meaning "earliest added". Sorting by date added (oldest first).\n`
				}

				// Check if query contains mood/contextual language
				const searchQueries: string[] = [query] // Start with original query
				let moodInfo = ''

				if (hasMoodContent(query)) {
					const moodAnalysis = analyzeMoodQuery(query)
					if (moodAnalysis.confidence >= 0.3) {
						// Add mood-based search terms while preserving original query
						const moodTerms = generateMoodSearchTerms(query)
						if (moodTerms.length > 0) {
							searchQueries.push(...moodTerms.slice(0, 3)) // Add top 3 mood-based terms
							moodInfo = `\n**Mood Analysis:** Detected "${moodAnalysis.detectedMoods.join(', ')}" - searching for ${moodTerms.slice(0, 3).join(', ')}\n`
						}
					}
				}

				// OPTIMIZATION: When cached client is available, fetch the complete
				// collection ONCE and filter in-memory for all query variants.
				// This avoids paginating the entire collection via API for every search.
				const allResults: DiscogsCollectionItem[] = []
				const seenReleaseIds = new Set<string>()
				let allReleases: DiscogsCollectionItem[] = []
				let collectionTruncationNote = ''

				if (cachedClient) {
					// Fetch complete collection with auto-retry so large collections don't exceed the 45s MCP timeout.
					// Cached pages are free (~10ms from KV), so retries only spend budget on uncached pages.
					const toolStart = Date.now()
					const TOOL_BUDGET_MS = 40000 // 40s total; 5s margin before 45s MCP timeout

					let collection = await cachedClient.getCompleteCollection(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
						50,
						30000,
					)
					while (collection.partial && Date.now() - toolStart < TOOL_BUDGET_MS - 5000) {
						const remaining = Math.max(TOOL_BUDGET_MS - (Date.now() - toolStart), 5000)
						collection = await cachedClient.getCompleteCollection(
							userProfile.username,
							session.accessToken,
							session.accessTokenSecret,
							env.DISCOGS_CONSUMER_KEY,
							env.DISCOGS_CONSUMER_SECRET,
							50,
							remaining,
						)
					}

					allReleases = collection.releases
					if (collection.partial || collection.pagination.items > collection.releases.length) {
						collectionTruncationNote = `\n\n⚠️ Your collection has ${collection.pagination.items} releases but only ${collection.releases.length} were indexed. Some results may be missing.`
					}

					// Semantic query detection: if the query is conceptual/descriptive
					// (not matching artists, albums, genres, or moods), short-circuit
					// and return the full collection for LLM-based selection.
					if (isSemanticQuery(query, allReleases)) {
						const semanticResult = formatCollectionForSemanticSearch(allReleases, query)
						if (collectionTruncationNote && semanticResult.content?.[0]?.type === 'text') {
							semanticResult.content[0].text += collectionTruncationNote
						}
						return semanticResult
					}

					// Run each query variant as an in-memory filter against the same dataset
					for (const searchQuery of searchQueries) {
						const filtered = filterReleasesInMemory(allReleases, searchQuery, {
							hasRecent,
							hasOld,
							sort: hasRecent ? 'added' : hasOld ? 'added' : undefined,
							sortOrder: hasRecent ? 'desc' : hasOld ? 'asc' : undefined,
						})

						for (const release of filtered) {
							const releaseKey = `${release.id}-${release.instance_id}`
							if (!seenReleaseIds.has(releaseKey)) {
								seenReleaseIds.add(releaseKey)
								allResults.push(release)
							}
						}
					}
				} else {
					// Single query or no cached client: use the existing search path
					// (which still benefits from per-page caching when available)
					for (const searchQuery of searchQueries) {
						const searchResults = await client.searchCollection(
							userProfile.username,
							session.accessToken,
							session.accessTokenSecret,
							{
								query: searchQuery,
								per_page,
							},
							env.DISCOGS_CONSUMER_KEY,
							env.DISCOGS_CONSUMER_SECRET,
						)

						for (const release of searchResults.releases) {
							const releaseKey = `${release.id}-${release.instance_id}`
							if (!seenReleaseIds.has(releaseKey)) {
								seenReleaseIds.add(releaseKey)
								allResults.push(release)
							}
						}
					}
				}

				// Sort combined results by rating and date (unless temporal sorting was applied)
				if (hasRecent) {
					allResults.sort((a, b) => new Date(b.date_added).getTime() - new Date(a.date_added).getTime())
				} else if (hasOld) {
					allResults.sort((a, b) => new Date(a.date_added).getTime() - new Date(b.date_added).getTime())
				} else {
					allResults.sort((a, b) => {
						if (a.rating !== b.rating) {
							return b.rating - a.rating
						}
						return new Date(b.date_added).getTime() - new Date(a.date_added).getTime()
					})
				}

				// Limit to requested page size
				const finalResults = allResults.slice(0, per_page)

				const summary = `Found ${allResults.length} results for "${query}" in your collection (showing ${finalResults.length} items):`

				// Create concise formatted list with genres and styles
				const releaseList = finalResults
					.map((release) => {
						const info = release.basic_information
						const artists = info.artists.map((a) => a.name).join(', ')
						const formats = info.formats.map((f) => f.name).join(', ')
						const genres = info.genres?.length ? info.genres.join(', ') : 'Unknown'
						const styles = info.styles?.length ? ` | Styles: ${info.styles.join(', ')}` : ''
						const rating = release.rating > 0 ? ` ⭐${release.rating}` : ''

						return `• [ID: ${release.id}] ${artists} - ${info.title} (${info.year})\n  Format: ${formats} | Genre: ${genres}${styles}${rating}`
					})
					.join('\n\n')

				return {
					content: [
						{
							type: 'text',
							text: `${summary}${temporalInfo}${moodInfo}\n${releaseList}\n\n**Tip:** Use the release IDs with the get_release tool for detailed information about specific albums.${collectionTruncationNote}`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to search collection: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: get_release
	 * Get detailed information about a specific release
	 */
	server.tool(
		'get_release',
		'Get detailed information about a specific release from Discogs, including tracklist, formats, labels, and more.',
		{
			release_id: z.string().describe('The Discogs release ID (e.g., from search results)'),
		},
		async ({ release_id }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const release = await client.getRelease(
					release_id,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const artists = (release.artists || []).map((a) => a.name).join(', ')
				const formats = (release.formats || []).map((f) => `${f.name} (${f.qty})`).join(', ')
				const genres = (release.genres || []).join(', ')
				const styles = (release.styles || []).join(', ')
				const labels = (release.labels || []).map((l) => `${l.name} (${l.catno})`).join(', ')

				let text = `**${artists} - ${release.title}**\n\n`
				text += `Year: ${release.year || 'Unknown'}\n`
				text += `Formats: ${formats}\n`
				text += `Genres: ${genres}\n`
				if (styles) text += `Styles: ${styles}\n`
				text += `Labels: ${labels}\n`
				if (release.country) text += `Country: ${release.country}\n`

				if (release.tracklist && release.tracklist.length > 0) {
					text += `\n**Tracklist:**\n`
					release.tracklist.forEach((track) => {
						text += `${track.position}. ${track.title}`
						if (track.duration) text += ` (${track.duration})`
						text += '\n'
					})
				}

				return {
					content: [
						{
							type: 'text',
							text,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to get release: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: get_collection_stats
	 * Get statistics about user's collection
	 */
	server.tool(
		'get_collection_stats',
		'Get comprehensive statistics about your Discogs collection including genre breakdown, decade analysis, format distribution, and ratings.',
		{},
		async () => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				// Compute stats from cached complete collection when available.
				// This reuses the same cached dataset as search_collection and
				// get_recommendations, so if either was called first, this is free.
				let stats
				let collectionTotalItems = 0
				let collectionIndexedItems = 0
				if (cachedClient) {
					const toolStart = Date.now()
					const TOOL_BUDGET_MS = 40000

					let collection = await cachedClient.getCompleteCollection(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
						50,
						30000,
					)
					while (collection.partial && Date.now() - toolStart < TOOL_BUDGET_MS - 5000) {
						const remaining = Math.max(TOOL_BUDGET_MS - (Date.now() - toolStart), 5000)
						collection = await cachedClient.getCompleteCollection(
							userProfile.username,
							session.accessToken,
							session.accessTokenSecret,
							env.DISCOGS_CONSUMER_KEY,
							env.DISCOGS_CONSUMER_SECRET,
							50,
							remaining,
						)
					}

					stats = cachedClient.computeStatsFromReleases(collection.releases)
					collectionTotalItems = collection.pagination.items
					collectionIndexedItems = collection.releases.length
				} else {
					stats = await client.getCollectionStats(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
					)
					collectionTotalItems = stats.totalReleases
					collectionIndexedItems = stats.totalReleases
				}

				const isIncomplete = collectionTotalItems > collectionIndexedItems

				let text = `**Collection Statistics for ${userProfile.username}**\n\n`
				if (isIncomplete) {
					text += `Total Releases: ${collectionIndexedItems} indexed of ${collectionTotalItems} total\n`
				} else {
					text += `Total Releases: ${stats.totalReleases}\n`
				}
				text += `Average Rating: ${stats.averageRating.toFixed(1)} (${stats.ratedReleases} rated releases)\n\n`

				text += `**Top Genres:**\n`
				const topGenres = Object.entries(stats.genreBreakdown)
					.sort(([, a], [, b]) => b - a)
					.slice(0, 5)
				topGenres.forEach(([genre, count]) => {
					text += `• ${genre}: ${count} releases\n`
				})

				text += `\n**By Decade:**\n`
				const topDecades = Object.entries(stats.decadeBreakdown)
					.sort(([, a], [, b]) => b - a)
					.slice(0, 5)
				topDecades.forEach(([decade, count]) => {
					text += `• ${decade}s: ${count} releases\n`
				})

				text += `\n**Top Formats:**\n`
				const topFormats = Object.entries(stats.formatBreakdown)
					.sort(([, a], [, b]) => b - a)
					.slice(0, 5)
				topFormats.forEach(([format, count]) => {
					text += `• ${format}: ${count} releases\n`
				})

				if (isIncomplete) {
					text += `\n⚠️ Only ${collectionIndexedItems} of your ${collectionTotalItems} releases have been indexed. Stats above reflect the indexed portion only.`
				}

				return {
					content: [
						{
							type: 'text',
							text,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to get collection stats: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: get_recommendations
	 * Get personalized music recommendations with mood support
	 */
	server.tool(
		'get_recommendations',
		"Get personalized music recommendations from your collection based on genre, decade, mood, or similarity to other releases. Supports mood-aware filtering with descriptors like 'mellow', 'energetic', 'melancholic'.",
		{
			limit: z.number().min(1).max(50).optional().default(10).describe('Number of recommendations to return (1-50)'),
			genre: z.string().optional().describe("Filter by genre or mood descriptor (e.g., 'jazz', 'mellow', 'energetic')"),
			decade: z.string().optional().describe("Filter by decade (e.g., '1970s', '1980')"),
			similar_to: z.string().optional().describe('Find releases similar to this artist/album (searches by musical characteristics)'),
			query: z.string().optional().describe('Additional search query or mood descriptor to refine recommendations'),
			format: z.string().optional().describe("Filter by format (e.g., 'Vinyl', 'CD', 'Cassette')"),
		},
		async ({ limit, genre, decade, similar_to, query, format }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				// Analyze mood content in parameters to enhance filtering
				let moodGenres: string[] = []
				let moodStyles: string[] = []
				let moodInfo = ''

				// Check for mood content in query parameter
				if (query && hasMoodContent(query)) {
					const moodAnalysis = analyzeMoodQuery(query)
					if (moodAnalysis.confidence >= 0.3) {
						moodGenres = moodAnalysis.suggestedGenres
						moodStyles = moodAnalysis.suggestedStyles
						moodInfo = `\n**Mood Analysis:** Detected "${moodAnalysis.detectedMoods.join(', ')}"${moodAnalysis.contextualHints.length ? ` (${moodAnalysis.contextualHints.join(', ')})` : ''}\n`
					}
				}

				// Also check genre parameter for mood terms
				if (genre && hasMoodContent(genre)) {
					const genreMoodAnalysis = analyzeMoodQuery(genre)
					if (genreMoodAnalysis.confidence >= 0.3) {
						moodGenres = [...moodGenres, ...genreMoodAnalysis.suggestedGenres]
						moodStyles = [...moodStyles, ...genreMoodAnalysis.suggestedStyles]
						if (!moodInfo) {
							moodInfo = `\n**Mood Analysis:** Detected "${genreMoodAnalysis.detectedMoods.join(', ')}" in genre filter\n`
						}
					}
				}

				// Remove duplicates from mood mappings
				moodGenres = [...new Set(moodGenres)]
				moodStyles = [...new Set(moodStyles)]

				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				// Get full collection for context-aware recommendations.
				// Uses getCompleteCollectionReleases() when cached client is available
				// (single fetch, cached for 45 min) instead of manual pagination.
				let allReleases: DiscogsCollectionItem[]
				if (cachedClient) {
					const toolStart = Date.now()
					const TOOL_BUDGET_MS = 40000

					let collectionResult = await cachedClient.getCompleteCollectionReleases(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
						30000,
					)
					while (collectionResult.partial && Date.now() - toolStart < TOOL_BUDGET_MS - 5000) {
						const remaining = Math.max(TOOL_BUDGET_MS - (Date.now() - toolStart), 5000)
						collectionResult = await cachedClient.getCompleteCollectionReleases(
							userProfile.username,
							session.accessToken,
							session.accessTokenSecret,
							env.DISCOGS_CONSUMER_KEY,
							env.DISCOGS_CONSUMER_SECRET,
							remaining,
						)
					}
					allReleases = collectionResult.releases
				} else {
					// Fallback: manual pagination when no cached client
					const fullCollection = await client.searchCollection(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						{ per_page: 100 },
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET,
					)
					allReleases = fullCollection.releases
					for (let page = 2; page <= fullCollection.pagination.pages; page++) {
						const pageResults = await client.searchCollection(
							userProfile.username,
							session.accessToken,
							session.accessTokenSecret,
							{ page, per_page: 100 },
							env.DISCOGS_CONSUMER_KEY,
							env.DISCOGS_CONSUMER_SECRET,
						)
						allReleases = allReleases.concat(pageResults.releases)
					}
				}

				// Filter releases based on context parameters
				let filteredReleases = allReleases

				// Filter by genre (enhanced with mood mapping)
				if (genre || moodGenres.length > 0) {
					filteredReleases = filteredReleases.filter((release) => {
						const releaseGenres = release.basic_information.genres?.map((g) => g.toLowerCase()) || []
						const releaseStyles = release.basic_information.styles?.map((s) => s.toLowerCase()) || []

						// Original genre matching (if genre parameter provided)
						let genreMatch = false
						if (genre) {
							const genreTerms = genre
								.toLowerCase()
								.split(/[\s,;|&]+/)
								.filter((term) => term.length > 0)
							genreMatch = genreTerms.some(
								(term) => releaseGenres.some((g) => g.includes(term)) || releaseStyles.some((s) => s.includes(term)),
							)
						}

						// Mood-based genre matching
						let moodMatch = false
						if (moodGenres.length > 0 || moodStyles.length > 0) {
							const lowerMoodGenres = moodGenres.map((g) => g.toLowerCase())
							const lowerMoodStyles = moodStyles.map((s) => s.toLowerCase())

							moodMatch =
								releaseGenres.some((g) => lowerMoodGenres.some((mg) => g.includes(mg) || mg.includes(g))) ||
								releaseStyles.some((s) => lowerMoodStyles.some((ms) => s.includes(ms) || ms.includes(s)))
						}

						// Return true if either genre or mood criteria match
						if (genre && (moodGenres.length > 0 || moodStyles.length > 0)) {
							return genreMatch || moodMatch
						} else if (genre) {
							return genreMatch
						} else {
							return moodMatch
						}
					})
				}

				// Filter by decade
				if (decade) {
					const decadeNum = parseInt(decade.replace(/s$/, ''))
					if (!isNaN(decadeNum)) {
						filteredReleases = filteredReleases.filter((release) => {
							const year = release.basic_information.year
							return year && year >= decadeNum && year < decadeNum + 10
						})
					}
				}

				// Filter by format
				if (format) {
					filteredReleases = filteredReleases.filter((release) => {
						return release.basic_information.formats?.some((f) => f.name.toLowerCase().includes(format.toLowerCase()))
					})
				}

				// Filter by similarity (complex logic preserved from original)
				if (similar_to) {
					const similarTerms = similar_to
						.toLowerCase()
						.split(/\s+/)
						.filter((term) => term.length > 2)

					const referenceReleases = filteredReleases.filter((release) => {
						const info = release.basic_information
						const searchableText = [
							...(info.artists?.map((artist) => artist.name) || []),
							info.title,
							...(info.genres || []),
							...(info.styles || []),
							...(info.labels?.map((label) => label.name) || []),
						]
							.join(' ')
							.toLowerCase()

						const matchingTerms = similarTerms.filter((term) => searchableText.includes(term)).length
						return matchingTerms >= Math.ceil(similarTerms.length * 0.5)
					})

					if (referenceReleases.length > 0) {
						// Extract musical characteristics from reference releases
						const refGenres = new Set<string>()
						const refStyles = new Set<string>()
						const refArtists = new Set<string>()
						let refEraStart = Infinity
						let refEraEnd = 0

						referenceReleases.forEach((release) => {
							const info = release.basic_information
							info.genres?.forEach((g) => refGenres.add(g.toLowerCase()))
							info.styles?.forEach((s) => refStyles.add(s.toLowerCase()))
							info.artists?.forEach((a) => refArtists.add(a.name.toLowerCase()))
							if (info.year) {
								refEraStart = Math.min(refEraStart, info.year)
								refEraEnd = Math.max(refEraEnd, info.year)
							}
						})

						// Expand era window by ±5 years
						const eraBuffer = 5
						refEraStart = refEraStart === Infinity ? 0 : refEraStart - eraBuffer
						refEraEnd = refEraEnd === 0 ? 9999 : refEraEnd + eraBuffer

						// Find releases with similar musical characteristics
						filteredReleases = filteredReleases.filter((release) => {
							const info = release.basic_information
							let similarityScore = 0

							// Genre matching (highest weight)
							const releaseGenres = (info.genres || []).map((g) => g.toLowerCase())
							const genreMatches = releaseGenres.filter((g) => refGenres.has(g)).length
							if (genreMatches > 0) similarityScore += genreMatches * 3

							// Style matching (high weight)
							const releaseStyles = (info.styles || []).map((s) => s.toLowerCase())
							const styleMatches = releaseStyles.filter((s) => refStyles.has(s)).length
							if (styleMatches > 0) similarityScore += styleMatches * 2

							// Era matching (medium weight)
							const releaseYear = info.year || 0
							if (releaseYear >= refEraStart && releaseYear <= refEraEnd) {
								similarityScore += 1
							}

							// Artist collaboration (bonus)
							const releaseArtists = (info.artists || []).map((a) => a.name.toLowerCase())
							const artistMatches = releaseArtists.filter((a) => refArtists.has(a)).length
							if (artistMatches > 0) similarityScore += artistMatches * 1

							return similarityScore >= 2
						})
					}
				}

				// Filter by general query
				if (query) {
					const queryTerms = query
						.toLowerCase()
						.split(/\s+/)
						.filter((term) => term.length > 2)

					// Genre/style/mood terms for OR logic
					const genreStyleTerms = [
						'ambient',
						'drone',
						'progressive',
						'rock',
						'jazz',
						'blues',
						'electronic',
						'techno',
						'house',
						'metal',
						'punk',
						'folk',
						'country',
						'classical',
						'hip',
						'hop',
						'rap',
						'soul',
						'funk',
						'disco',
						'reggae',
						'ska',
						'indie',
						'alternative',
						'psychedelic',
						'experimental',
						'moody',
						'melancholy',
						'energetic',
						'upbeat',
						'mellow',
						'chill',
						'relaxing',
						'dark',
						'romantic',
					]

					const isGenreStyleMoodQuery = queryTerms.some((term) => genreStyleTerms.includes(term.toLowerCase()))

					filteredReleases = filteredReleases.filter((release) => {
						const info = release.basic_information
						const searchableText = [
							...(info.artists?.map((artist) => artist.name) || []),
							info.title,
							...(info.genres || []),
							...(info.styles || []),
							...(info.labels?.map((label) => label.name) || []),
						]
							.join(' ')
							.toLowerCase()

						if (isGenreStyleMoodQuery) {
							// OR logic for genre/style/mood
							const matchingTerms = queryTerms.filter((term) => searchableText.includes(term)).length
							return matchingTerms >= 1
						} else {
							// Require 50% match for other queries
							const matchingTerms = queryTerms.filter((term) => searchableText.includes(term)).length
							return matchingTerms >= Math.ceil(queryTerms.length * 0.5)
						}
					})
				}

				// Calculate relevance scores for query-based searches
				if (query) {
					const queryTerms = query
						.toLowerCase()
						.split(/\s+/)
						.filter((term) => term.length > 2)

					filteredReleases = filteredReleases
						.map((release): ReleaseWithRelevance => {
							const info = release.basic_information
							const searchableText = [
								...(info.artists?.map((artist) => artist.name) || []),
								info.title,
								...(info.genres || []),
								...(info.styles || []),
								...(info.labels?.map((label) => label.name) || []),
							]
								.join(' ')
								.toLowerCase()

							const matchingTerms = queryTerms.filter((term) => searchableText.includes(term)).length
							const relevanceScore = matchingTerms / queryTerms.length

							return { ...release, relevanceScore }
						})
						.sort((a, b) => {
							const aRelevance = a.relevanceScore || 0
							const bRelevance = b.relevanceScore || 0
							if (aRelevance !== bRelevance) {
								return bRelevance - aRelevance
							}
							if (a.rating !== b.rating) {
								return b.rating - a.rating
							}
							return new Date(b.date_added).getTime() - new Date(a.date_added).getTime()
						})
				} else {
					// Sort by rating and date
					filteredReleases.sort((a, b) => {
						if (a.rating !== b.rating) {
							return b.rating - a.rating
						}
						return new Date(b.date_added).getTime() - new Date(a.date_added).getTime()
					})
				}

				// Limit results
				const recommendations = filteredReleases.slice(0, limit)

				// Build response
				let text = `**Context-Aware Music Recommendations**\n\n`

				if (genre || decade || similar_to || query || format || moodGenres.length > 0) {
					text += `**Filters Applied:**\n`
					if (genre) text += `• Genre: ${genre}\n`
					if (decade) text += `• Decade: ${decade}\n`
					if (format) text += `• Format: ${format}\n`
					if (similar_to) text += `• Similar to: ${similar_to}\n`
					if (query) text += `• Query: ${query}\n`
					if (moodGenres.length > 0) text += `• Mood-based genres: ${moodGenres.slice(0, 5).join(', ')}\n`
					text += `\n`
				}

				if (moodInfo) {
					text += moodInfo
				}

				text += `Found ${filteredReleases.length} matching releases in your collection (showing top ${recommendations.length}):\n\n`

				if (recommendations.length === 0) {
					text += `No releases found matching your criteria. Try:\n`
					text += `• Broadening your search terms\n`
					text += `• Using different genres or decades\n`
					text += `• Searching for specific artists you own\n`
					text += `• Using mood descriptors like "mellow", "energetic", "melancholy"\n`
					text += `• Trying contextual terms like "Sunday evening", "rainy day", "workout"\n`
				} else {
					recommendations.forEach((release, index) => {
						const info = release.basic_information
						const artists = info.artists.map((a) => a.name).join(', ')
						const formats = info.formats?.map((f) => f.name).join(', ') || 'Unknown'
						const genres = info.genres?.join(', ') || 'Unknown'
						const year = info.year || 'Unknown'
						const rating = release.rating > 0 ? ` ⭐${release.rating}` : ''
						const relevance =
							query && 'relevanceScore' in release ? ` (${Math.round((release as ReleaseWithRelevance).relevanceScore! * 100)}% match)` : ''

						text += `${index + 1}. **${artists} - ${info.title}** (${year})${rating}${relevance}\n`
						text += `   Format: ${formats} | Genres: ${genres}\n`
						if (info.styles && info.styles.length > 0) {
							text += `   Styles: ${info.styles.join(', ')}\n`
						}
						text += `   Release ID: ${release.id}\n\n`
					})

					text += `**Tip:** Use the get_release tool with any Release ID for detailed information about specific albums.`
				}

				return {
					content: [
						{
							type: 'text',
							text,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to get recommendations: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: get_cache_stats
	 * Get cache performance statistics
	 */
	server.tool(
		'get_cache_stats',
		'Get cache performance statistics including total entries, pending requests, and data type breakdown.',
		{},
		async () => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				if (!cachedClient) {
					return {
						content: [
							{
								type: 'text',
								text: '**Cache Statistics**\n\nCaching is not available - no KV storage configured. All requests go directly to the Discogs API.',
							},
						],
					}
				}

				const stats = await cachedClient.getCacheStats()

				let text = '**Cache Performance Statistics**\n\n'
				text += `📊 **Total Cache Entries:** ${stats.totalEntries}\n`
				text += `⏳ **Pending Requests:** ${stats.pendingRequests}\n\n`

				if (Object.keys(stats.entriesByType).length > 0) {
					text += '**Cached Data Types:**\n'
					for (const [type, count] of Object.entries(stats.entriesByType)) {
						text += `• ${type}: ${count} entries\n`
					}
				} else {
					text += '**No cached data** - Cache is empty or recently cleared\n'
				}

				text += '\n**Cache Benefits:**\n'
				text += '• Reduced API calls to Discogs\n'
				text += '• Faster response times\n'
				text += '• Better rate limit compliance\n'
				text += '• Request deduplication for concurrent users\n'

				return {
					content: [
						{
							type: 'text',
							text,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to get cache stats: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	// ──────────────────────────────────────────────
	// Collection write tools
	// ──────────────────────────────────────────────

	/**
	 * Tool: list_folders
	 * List all collection folders
	 */
	server.tool(
		'list_folders',
		'List all folders in your Discogs collection. Shows folder ID, name, and release count for each folder. Folder 0 is "All" (virtual), folder 1 is "Uncategorized" (default).',
		{},
		async () => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const folders = await client.listFolders(
					userProfile.username,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				let text = `**Collection Folders for ${userProfile.username}**\n\n`
				text += `Total folders: ${folders.length}\n\n`

				for (const folder of folders) {
					text += `• **${folder.name}** (ID: ${folder.id}) — ${folder.count} releases\n`
				}

				return {
					content: [{ type: 'text', text }],
				}
			} catch (error) {
				throw new Error(`Failed to list folders: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: create_folder
	 * Create a new collection folder
	 */
	server.tool(
		'create_folder',
		'Create a new folder in your Discogs collection for organizing releases.',
		{
			name: z.string().min(1).max(100).describe('Name for the new folder'),
		},
		async ({ name }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const folder = await client.createFolder(
					userProfile.username,
					name,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				return {
					content: [
						{
							type: 'text',
							text: `Created folder **${folder.name}** (ID: ${folder.id})`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: edit_folder
	 * Rename a collection folder
	 */
	server.tool(
		'edit_folder',
		'Rename an existing folder in your Discogs collection. Cannot rename the system folders (All or Uncategorized).',
		{
			folder_id: z.number().min(2).describe('ID of the folder to rename (must be 2 or higher — system folders cannot be renamed)'),
			name: z.string().min(1).max(100).describe('New name for the folder'),
		},
		async ({ folder_id, name }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const folder = await client.editFolder(
					userProfile.username,
					folder_id,
					name,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				return {
					content: [
						{
							type: 'text',
							text: `Renamed folder ${folder_id} to **${folder.name}**`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to edit folder: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: delete_folder
	 * Delete a collection folder (must be empty)
	 */
	server.tool(
		'delete_folder',
		'Delete a folder from your Discogs collection. The folder must be empty (no releases). Cannot delete system folders (All or Uncategorized).',
		{
			folder_id: z.number().min(2).describe('ID of the folder to delete (must be 2 or higher — system folders cannot be deleted)'),
		},
		async ({ folder_id }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				await client.deleteFolder(
					userProfile.username,
					folder_id,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				return {
					content: [
						{
							type: 'text',
							text: `Deleted folder ${folder_id}`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to delete folder: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: add_to_collection
	 * Add a release to a collection folder
	 */
	server.tool(
		'add_to_collection',
		'Add a release to a folder in your Discogs collection. If no folder is specified, adds to the Uncategorized folder (ID 1).',
		{
			release_id: z.number().describe('The Discogs release ID to add'),
			folder_id: z.number().optional().default(1).describe('Folder ID to add the release to (default: 1 = Uncategorized)'),
		},
		async ({ release_id, folder_id }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const result = await client.addToFolder(
					userProfile.username,
					folder_id,
					release_id,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				return {
					content: [
						{
							type: 'text',
							text: `Added release ${release_id} to folder ${folder_id} (instance ID: ${result.instance_id})`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to add to collection: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: remove_from_collection
	 * Remove a release instance from a collection folder
	 */
	server.tool(
		'remove_from_collection',
		'Remove a specific release instance from a folder in your Discogs collection. Use search_collection to find the instance_id for a release.',
		{
			folder_id: z.number().describe('Folder ID containing the release'),
			release_id: z.number().describe('The Discogs release ID'),
			instance_id: z.number().describe('The specific instance ID to remove (from search_collection results)'),
		},
		async ({ folder_id, release_id, instance_id }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				await client.removeFromFolder(
					userProfile.username,
					folder_id,
					release_id,
					instance_id,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				return {
					content: [
						{
							type: 'text',
							text: `Removed release ${release_id} (instance ${instance_id}) from folder ${folder_id}`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to remove from collection: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: move_release
	 * Move a release instance to a different folder
	 */
	server.tool(
		'move_release',
		'Move a release instance to a different folder in your Discogs collection. Use search_collection to find release and instance IDs, and list_folders to see available folders.',
		{
			folder_id: z.number().describe('Current folder ID containing the release'),
			release_id: z.number().describe('The Discogs release ID'),
			instance_id: z.number().describe('The specific instance ID to move'),
			target_folder_id: z.number().describe('Destination folder ID'),
		},
		async ({ folder_id, release_id, instance_id, target_folder_id }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				await client.editInstance(
					userProfile.username,
					folder_id,
					release_id,
					instance_id,
					{ folder_id: target_folder_id },
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				return {
					content: [
						{
							type: 'text',
							text: `Moved release ${release_id} (instance ${instance_id}) from folder ${folder_id} to folder ${target_folder_id}`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to move release: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: rate_release
	 * Rate a release in your collection (0-5 stars)
	 */
	server.tool(
		'rate_release',
		'Rate a release in your Discogs collection from 0 (no rating) to 5 stars. Use search_collection to find release and instance IDs.',
		{
			folder_id: z.number().describe('Folder ID containing the release'),
			release_id: z.number().describe('The Discogs release ID'),
			instance_id: z.number().describe('The specific instance ID to rate'),
			rating: z.number().min(0).max(5).describe('Rating from 0 (remove rating) to 5 stars'),
		},
		async ({ folder_id, release_id, instance_id, rating }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				await client.editInstance(
					userProfile.username,
					folder_id,
					release_id,
					instance_id,
					{ rating },
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const ratingText = rating === 0 ? 'Removed rating from' : `Rated ${rating}/5 stars:`
				return {
					content: [
						{
							type: 'text',
							text: `${ratingText} release ${release_id} (instance ${instance_id})`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to rate release: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: list_custom_fields
	 * List custom fields defined in the user's collection
	 */
	server.tool(
		'list_custom_fields',
		'List all custom fields defined in your Discogs collection. Custom fields allow you to add metadata like notes, tags, or categories to releases.',
		{},
		async () => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const fields = await client.listCustomFields(
					userProfile.username,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				if (fields.length === 0) {
					return {
						content: [
							{
								type: 'text',
								text: `**Custom Fields for ${userProfile.username}**\n\nNo custom fields defined. You can create custom fields in your Discogs collection settings at discogs.com.`,
							},
						],
					}
				}

				let text = `**Custom Fields for ${userProfile.username}**\n\n`
				for (const field of fields) {
					text += `• **${field.name}** (ID: ${field.id}, type: ${field.type})`
					if (field.options && field.options.length > 0) {
						text += `\n  Options: ${field.options.join(', ')}`
					}
					text += '\n'
				}

				return {
					content: [{ type: 'text', text }],
				}
			} catch (error) {
				throw new Error(`Failed to list custom fields: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: edit_custom_field
	 * Set a custom field value on a collection instance
	 */
	server.tool(
		'edit_custom_field',
		'Set a custom field value on a release in your Discogs collection. Use list_custom_fields to see available fields and their IDs. For dropdown fields, the value must match one of the defined options.',
		{
			folder_id: z.number().describe('Folder ID containing the release'),
			release_id: z.number().describe('The Discogs release ID'),
			instance_id: z.number().describe('The specific instance ID'),
			field_id: z.number().describe('Custom field ID (from list_custom_fields)'),
			value: z.string().describe('Value to set for the field'),
		},
		async ({ folder_id, release_id, instance_id, field_id, value }) => {
			const { session, connectionId } = await getSessionContext()

			if (!session) {
				return {
					content: [
						{
							type: 'text',
							text: generateAuthInstructions(connectionId),
						},
					],
				}
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				await client.editCustomFieldValue(
					userProfile.username,
					folder_id,
					release_id,
					instance_id,
					field_id,
					value,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				return {
					content: [
						{
							type: 'text',
							text: `Updated field ${field_id} to "${value}" on release ${release_id} (instance ${instance_id})`,
						},
					],
				}
			} catch (error) {
				throw new Error(`Failed to edit custom field: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)
}
