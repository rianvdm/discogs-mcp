/**
 * Authenticated tools - require Discogs OAuth authentication
 * These tools can only be called after the user has authenticated via OAuth 1.0a
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../../types/env.js";

import { DiscogsClient } from "../../clients/discogs.js";
import { CachedDiscogsClient } from "../../clients/cachedDiscogs.js";
import {
	analyzeMoodQuery,
	hasMoodContent,
	generateMoodSearchTerms,
} from "../../utils/moodMapping.js";
import type { DiscogsCollectionItem } from "../../clients/discogs.js";
import type { SessionContext } from "../server.js";

/**
 * Type for release with relevance score
 */
type ReleaseWithRelevance = DiscogsCollectionItem & { relevanceScore?: number };

/**
 * Get authentication instructions for unauthenticated requests
 */
function generateAuthInstructions(connectionId?: string): string {
	const baseUrl = "https://discogs-mcp-prod.rian-db8.workers.dev";
	const loginUrl = connectionId
		? `${baseUrl}/login?connection_id=${connectionId}`
		: `${baseUrl}/login`;

	return `🔐 **Authentication Required**

You need to authenticate with Discogs to use this tool.

**How to authenticate:**
1. Visit: ${loginUrl}
2. Sign in with your Discogs account
3. Authorize access to your collection
4. Return here and try again

Your authentication will be secure and tied to your specific session.`;
}

/**
 * Register all authenticated tools that require Discogs OAuth
 */
export function registerAuthenticatedTools(
	server: McpServer,
	env: Env,
	getSessionContext: () => Promise<SessionContext>
): void {
	// Create Discogs clients
	const discogsClient = new DiscogsClient();
	// Set KV for persistent rate limiting across Worker invocations
	if (env.MCP_SESSIONS) {
		discogsClient.setKV(env.MCP_SESSIONS);
	}
	const cachedClient = env.MCP_SESSIONS
		? new CachedDiscogsClient(discogsClient, env.MCP_SESSIONS)
		: null;
	const client = cachedClient || discogsClient;

	/**
	 * Tool: search_collection
	 * Search user's Discogs collection with mood-aware queries
	 */
	server.tool(
		"search_collection",
		"Search your Discogs collection with natural language and mood-aware queries. Supports mood descriptors like 'mellow jazz', contextual queries like 'Sunday evening music', and temporal terms like 'recent' or 'oldest'.",
		{
			query: z
				.string()
				.describe(
					"Search query - can include mood descriptors (mellow, energetic, melancholic), contextual terms (Sunday evening, rainy day), or specific searches (artist, album, genre)"
				),
			per_page: z
				.number()
				.min(1)
				.max(100)
				.optional()
				.default(50)
				.describe("Number of results to return (1-100)"),
		},
		async ({ query, per_page }) => {
			const { session, connectionId } = await getSessionContext();

			if (!session) {
				return {
					content: [
						{
							type: "text",
							text: generateAuthInstructions(connectionId),
						},
					],
				};
			}

			try {
				// Get user profile
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				// Check for temporal terms
				const queryWords = query.toLowerCase().split(/\s+/);
				const hasRecent = queryWords.some((word) =>
					["recent", "recently", "new", "newest", "latest"].includes(word)
				);
				const hasOld = queryWords.some((word) =>
					["old", "oldest", "earliest"].includes(word)
				);

				let temporalInfo = "";
				if (hasRecent) {
					temporalInfo = `\n**Search Strategy:** Interpreted "${query}" as searching for items with "recent" meaning "most recently added". Sorting by date added (newest first).\n`;
				} else if (hasOld) {
					temporalInfo = `\n**Search Strategy:** Interpreted "${query}" as searching for items with "old/oldest" meaning "earliest added". Sorting by date added (oldest first).\n`;
				}

				// Check if query contains mood/contextual language
				const searchQueries: string[] = [query]; // Start with original query
				let moodInfo = "";

				if (hasMoodContent(query)) {
					const moodAnalysis = analyzeMoodQuery(query);
					if (moodAnalysis.confidence >= 0.3) {
						// Add mood-based search terms while preserving original query
						const moodTerms = generateMoodSearchTerms(query);
						if (moodTerms.length > 0) {
							searchQueries.push(...moodTerms.slice(0, 3)); // Add top 3 mood-based terms
							moodInfo = `\n**Mood Analysis:** Detected "${moodAnalysis.detectedMoods.join(", ")}" - searching for ${moodTerms.slice(0, 3).join(", ")}\n`;
						}
					}
				}

				// Perform searches for all query variations and combine results
				const allResults: DiscogsCollectionItem[] = [];
				const seenReleaseIds = new Set<string>();

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
						env.DISCOGS_CONSUMER_SECRET
					);

					// Add unique results (avoid duplicates)
					for (const release of searchResults.releases) {
						const releaseKey = `${release.id}-${release.instance_id}`;
						if (!seenReleaseIds.has(releaseKey)) {
							seenReleaseIds.add(releaseKey);
							allResults.push(release);
						}
					}
				}

				// Sort combined results by rating and date (unless temporal sorting was applied)
				if (!hasRecent && !hasOld) {
					allResults.sort((a, b) => {
						if (a.rating !== b.rating) {
							return b.rating - a.rating;
						}
						return (
							new Date(b.date_added).getTime() -
							new Date(a.date_added).getTime()
						);
					});
				}

				// Limit to requested page size
				const finalResults = allResults.slice(0, per_page);

				const summary = `Found ${allResults.length} results for "${query}" in your collection (showing ${finalResults.length} items):`;

				// Create concise formatted list with genres and styles
				const releaseList = finalResults
					.map((release) => {
						const info = release.basic_information;
						const artists = info.artists.map((a) => a.name).join(", ");
						const formats = info.formats.map((f) => f.name).join(", ");
						const genres = info.genres?.length
							? info.genres.join(", ")
							: "Unknown";
						const styles = info.styles?.length
							? ` | Styles: ${info.styles.join(", ")}`
							: "";
						const rating = release.rating > 0 ? ` ⭐${release.rating}` : "";

						return `• [ID: ${release.id}] ${artists} - ${info.title} (${info.year})\n  Format: ${formats} | Genre: ${genres}${styles}${rating}`;
					})
					.join("\n\n");

				return {
					content: [
						{
							type: "text",
							text: `${summary}${temporalInfo}${moodInfo}\n${releaseList}\n\n**Tip:** Use the release IDs with the get_release tool for detailed information about specific albums.`,
						},
					],
				};
			} catch (error) {
				throw new Error(
					`Failed to search collection: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		}
	);

	/**
	 * Tool: get_release
	 * Get detailed information about a specific release
	 */
	server.tool(
		"get_release",
		"Get detailed information about a specific release from Discogs, including tracklist, formats, labels, and more.",
		{
			release_id: z
				.string()
				.describe("The Discogs release ID (e.g., from search results)"),
		},
		async ({ release_id }) => {
			const { session, connectionId } = await getSessionContext();

			if (!session) {
				return {
					content: [
						{
							type: "text",
							text: generateAuthInstructions(connectionId),
						},
					],
				};
			}

			try {
				const release = await client.getRelease(
					release_id,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				const artists = (release.artists || []).map((a) => a.name).join(", ");
				const formats = (release.formats || [])
					.map((f) => `${f.name} (${f.qty})`)
					.join(", ");
				const genres = (release.genres || []).join(", ");
				const styles = (release.styles || []).join(", ");
				const labels = (release.labels || [])
					.map((l) => `${l.name} (${l.catno})`)
					.join(", ");

				let text = `**${artists} - ${release.title}**\n\n`;
				text += `Year: ${release.year || "Unknown"}\n`;
				text += `Formats: ${formats}\n`;
				text += `Genres: ${genres}\n`;
				if (styles) text += `Styles: ${styles}\n`;
				text += `Labels: ${labels}\n`;
				if (release.country) text += `Country: ${release.country}\n`;

				if (release.tracklist && release.tracklist.length > 0) {
					text += `\n**Tracklist:**\n`;
					release.tracklist.forEach((track) => {
						text += `${track.position}. ${track.title}`;
						if (track.duration) text += ` (${track.duration})`;
						text += "\n";
					});
				}

				return {
					content: [
						{
							type: "text",
							text,
						},
					],
				};
			} catch (error) {
				throw new Error(
					`Failed to get release: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		}
	);

	/**
	 * Tool: get_collection_stats
	 * Get statistics about user's collection
	 */
	server.tool(
		"get_collection_stats",
		"Get comprehensive statistics about your Discogs collection including genre breakdown, decade analysis, format distribution, and ratings.",
		{},
		async () => {
			const { session, connectionId } = await getSessionContext();

			if (!session) {
				return {
					content: [
						{
							type: "text",
							text: generateAuthInstructions(connectionId),
						},
					],
				};
			}

			try {
				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				const stats = await client.getCollectionStats(
					userProfile.username,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				let text = `**Collection Statistics for ${userProfile.username}**\n\n`;
				text += `Total Releases: ${stats.totalReleases}\n`;
				text += `Average Rating: ${stats.averageRating.toFixed(1)} (${stats.ratedReleases} rated releases)\n\n`;

				text += `**Top Genres:**\n`;
				const topGenres = Object.entries(stats.genreBreakdown)
					.sort(([, a], [, b]) => b - a)
					.slice(0, 5);
				topGenres.forEach(([genre, count]) => {
					text += `• ${genre}: ${count} releases\n`;
				});

				text += `\n**By Decade:**\n`;
				const topDecades = Object.entries(stats.decadeBreakdown)
					.sort(([, a], [, b]) => b - a)
					.slice(0, 5);
				topDecades.forEach(([decade, count]) => {
					text += `• ${decade}s: ${count} releases\n`;
				});

				text += `\n**Top Formats:**\n`;
				const topFormats = Object.entries(stats.formatBreakdown)
					.sort(([, a], [, b]) => b - a)
					.slice(0, 5);
				topFormats.forEach(([format, count]) => {
					text += `• ${format}: ${count} releases\n`;
				});

				return {
					content: [
						{
							type: "text",
							text,
						},
					],
				};
			} catch (error) {
				throw new Error(
					`Failed to get collection stats: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		}
	);

	/**
	 * Tool: get_recommendations
	 * Get personalized music recommendations with mood support
	 */
	server.tool(
		"get_recommendations",
		"Get personalized music recommendations from your collection based on genre, decade, mood, or similarity to other releases. Supports mood-aware filtering with descriptors like 'mellow', 'energetic', 'melancholic'.",
		{
			limit: z
				.number()
				.min(1)
				.max(50)
				.optional()
				.default(10)
				.describe("Number of recommendations to return (1-50)"),
			genre: z
				.string()
				.optional()
				.describe(
					"Filter by genre or mood descriptor (e.g., 'jazz', 'mellow', 'energetic')"
				),
			decade: z
				.string()
				.optional()
				.describe("Filter by decade (e.g., '1970s', '1980')"),
			similar_to: z
				.string()
				.optional()
				.describe(
					"Find releases similar to this artist/album (searches by musical characteristics)"
				),
			query: z
				.string()
				.optional()
				.describe(
					"Additional search query or mood descriptor to refine recommendations"
				),
			format: z
				.string()
				.optional()
				.describe("Filter by format (e.g., 'Vinyl', 'CD', 'Cassette')"),
		},
		async ({ limit, genre, decade, similar_to, query, format }) => {
			const { session, connectionId } = await getSessionContext();

			if (!session) {
				return {
					content: [
						{
							type: "text",
							text: generateAuthInstructions(connectionId),
						},
					],
				};
			}

			try {
				// Analyze mood content in parameters to enhance filtering
				let moodGenres: string[] = [];
				let moodStyles: string[] = [];
				let moodInfo = "";

				// Check for mood content in query parameter
				if (query && hasMoodContent(query)) {
					const moodAnalysis = analyzeMoodQuery(query);
					if (moodAnalysis.confidence >= 0.3) {
						moodGenres = moodAnalysis.suggestedGenres;
						moodStyles = moodAnalysis.suggestedStyles;
						moodInfo = `\n**Mood Analysis:** Detected "${moodAnalysis.detectedMoods.join(", ")}"${moodAnalysis.contextualHints.length ? ` (${moodAnalysis.contextualHints.join(", ")})` : ""}\n`;
					}
				}

				// Also check genre parameter for mood terms
				if (genre && hasMoodContent(genre)) {
					const genreMoodAnalysis = analyzeMoodQuery(genre);
					if (genreMoodAnalysis.confidence >= 0.3) {
						moodGenres = [...moodGenres, ...genreMoodAnalysis.suggestedGenres];
						moodStyles = [...moodStyles, ...genreMoodAnalysis.suggestedStyles];
						if (!moodInfo) {
							moodInfo = `\n**Mood Analysis:** Detected "${genreMoodAnalysis.detectedMoods.join(", ")}" in genre filter\n`;
						}
					}
				}

				// Remove duplicates from mood mappings
				moodGenres = [...new Set(moodGenres)];
				moodStyles = [...new Set(moodStyles)];

				const userProfile = await client.getUserProfile(
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				// Get full collection for context-aware recommendations
				const fullCollection = await client.searchCollection(
					userProfile.username,
					session.accessToken,
					session.accessTokenSecret,
					{ per_page: 100 },
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET
				);

				// Get all collection items by paginating through all pages
				let allReleases = fullCollection.releases;
				for (
					let page = 2;
					page <= fullCollection.pagination.pages;
					page++
				) {
					const pageResults = await client.searchCollection(
						userProfile.username,
						session.accessToken,
						session.accessTokenSecret,
						{ page, per_page: 100 },
						env.DISCOGS_CONSUMER_KEY,
						env.DISCOGS_CONSUMER_SECRET
					);
					allReleases = allReleases.concat(pageResults.releases);
				}

				// Filter releases based on context parameters
				let filteredReleases = allReleases;

				// Filter by genre (enhanced with mood mapping)
				if (genre || moodGenres.length > 0) {
					filteredReleases = filteredReleases.filter((release) => {
						const releaseGenres =
							release.basic_information.genres?.map((g) => g.toLowerCase()) ||
							[];
						const releaseStyles =
							release.basic_information.styles?.map((s) => s.toLowerCase()) ||
							[];

						// Original genre matching (if genre parameter provided)
						let genreMatch = false;
						if (genre) {
							const genreTerms = genre
								.toLowerCase()
								.split(/[\s,;|&]+/)
								.filter((term) => term.length > 0);
							genreMatch = genreTerms.some(
								(term) =>
									releaseGenres.some((g) => g.includes(term)) ||
									releaseStyles.some((s) => s.includes(term))
							);
						}

						// Mood-based genre matching
						let moodMatch = false;
						if (moodGenres.length > 0 || moodStyles.length > 0) {
							const lowerMoodGenres = moodGenres.map((g) => g.toLowerCase());
							const lowerMoodStyles = moodStyles.map((s) => s.toLowerCase());

							moodMatch =
								releaseGenres.some((g) =>
									lowerMoodGenres.some((mg) => g.includes(mg) || mg.includes(g))
								) ||
								releaseStyles.some((s) =>
									lowerMoodStyles.some((ms) => s.includes(ms) || ms.includes(s))
								);
						}

						// Return true if either genre or mood criteria match
						if (genre && (moodGenres.length > 0 || moodStyles.length > 0)) {
							return genreMatch || moodMatch;
						} else if (genre) {
							return genreMatch;
						} else {
							return moodMatch;
						}
					});
				}

				// Filter by decade
				if (decade) {
					const decadeNum = parseInt(decade.replace(/s$/, ""));
					if (!isNaN(decadeNum)) {
						filteredReleases = filteredReleases.filter((release) => {
							const year = release.basic_information.year;
							return year && year >= decadeNum && year < decadeNum + 10;
						});
					}
				}

				// Filter by format
				if (format) {
					filteredReleases = filteredReleases.filter((release) => {
						return release.basic_information.formats?.some((f) =>
							f.name.toLowerCase().includes(format.toLowerCase())
						);
					});
				}

				// Filter by similarity (complex logic preserved from original)
				if (similar_to) {
					const similarTerms = similar_to
						.toLowerCase()
						.split(/\s+/)
						.filter((term) => term.length > 2);

					const referenceReleases = filteredReleases.filter((release) => {
						const info = release.basic_information;
						const searchableText = [
							...(info.artists?.map((artist) => artist.name) || []),
							info.title,
							...(info.genres || []),
							...(info.styles || []),
							...(info.labels?.map((label) => label.name) || []),
						]
							.join(" ")
							.toLowerCase();

						const matchingTerms = similarTerms.filter((term) =>
							searchableText.includes(term)
						).length;
						return matchingTerms >= Math.ceil(similarTerms.length * 0.5);
					});

					if (referenceReleases.length > 0) {
						// Extract musical characteristics from reference releases
						const refGenres = new Set<string>();
						const refStyles = new Set<string>();
						const refArtists = new Set<string>();
						let refEraStart = Infinity;
						let refEraEnd = 0;

						referenceReleases.forEach((release) => {
							const info = release.basic_information;
							info.genres?.forEach((g) => refGenres.add(g.toLowerCase()));
							info.styles?.forEach((s) => refStyles.add(s.toLowerCase()));
							info.artists?.forEach((a) => refArtists.add(a.name.toLowerCase()));
							if (info.year) {
								refEraStart = Math.min(refEraStart, info.year);
								refEraEnd = Math.max(refEraEnd, info.year);
							}
						});

						// Expand era window by ±5 years
						const eraBuffer = 5;
						refEraStart = refEraStart === Infinity ? 0 : refEraStart - eraBuffer;
						refEraEnd = refEraEnd === 0 ? 9999 : refEraEnd + eraBuffer;

						// Find releases with similar musical characteristics
						filteredReleases = filteredReleases.filter((release) => {
							const info = release.basic_information;
							let similarityScore = 0;

							// Genre matching (highest weight)
							const releaseGenres = (info.genres || []).map((g) =>
								g.toLowerCase()
							);
							const genreMatches = releaseGenres.filter((g) =>
								refGenres.has(g)
							).length;
							if (genreMatches > 0) similarityScore += genreMatches * 3;

							// Style matching (high weight)
							const releaseStyles = (info.styles || []).map((s) =>
								s.toLowerCase()
							);
							const styleMatches = releaseStyles.filter((s) =>
								refStyles.has(s)
							).length;
							if (styleMatches > 0) similarityScore += styleMatches * 2;

							// Era matching (medium weight)
							const releaseYear = info.year || 0;
							if (releaseYear >= refEraStart && releaseYear <= refEraEnd) {
								similarityScore += 1;
							}

							// Artist collaboration (bonus)
							const releaseArtists = (info.artists || []).map((a) =>
								a.name.toLowerCase()
							);
							const artistMatches = releaseArtists.filter((a) =>
								refArtists.has(a)
							).length;
							if (artistMatches > 0) similarityScore += artistMatches * 1;

							return similarityScore >= 2;
						});
					}
				}

				// Filter by general query
				if (query) {
					const queryTerms = query
						.toLowerCase()
						.split(/\s+/)
						.filter((term) => term.length > 2);

					// Genre/style/mood terms for OR logic
					const genreStyleTerms = [
						"ambient",
						"drone",
						"progressive",
						"rock",
						"jazz",
						"blues",
						"electronic",
						"techno",
						"house",
						"metal",
						"punk",
						"folk",
						"country",
						"classical",
						"hip",
						"hop",
						"rap",
						"soul",
						"funk",
						"disco",
						"reggae",
						"ska",
						"indie",
						"alternative",
						"psychedelic",
						"experimental",
						"moody",
						"melancholy",
						"energetic",
						"upbeat",
						"mellow",
						"chill",
						"relaxing",
						"dark",
						"romantic",
					];

					const isGenreStyleMoodQuery = queryTerms.some((term) =>
						genreStyleTerms.includes(term.toLowerCase())
					);

					filteredReleases = filteredReleases.filter((release) => {
						const info = release.basic_information;
						const searchableText = [
							...(info.artists?.map((artist) => artist.name) || []),
							info.title,
							...(info.genres || []),
							...(info.styles || []),
							...(info.labels?.map((label) => label.name) || []),
						]
							.join(" ")
							.toLowerCase();

						if (isGenreStyleMoodQuery) {
							// OR logic for genre/style/mood
							const matchingTerms = queryTerms.filter((term) =>
								searchableText.includes(term)
							).length;
							return matchingTerms >= 1;
						} else {
							// Require 50% match for other queries
							const matchingTerms = queryTerms.filter((term) =>
								searchableText.includes(term)
							).length;
							return matchingTerms >= Math.ceil(queryTerms.length * 0.5);
						}
					});
				}

				// Calculate relevance scores for query-based searches
				if (query) {
					const queryTerms = query
						.toLowerCase()
						.split(/\s+/)
						.filter((term) => term.length > 2);

					filteredReleases = filteredReleases
						.map((release): ReleaseWithRelevance => {
							const info = release.basic_information;
							const searchableText = [
								...(info.artists?.map((artist) => artist.name) || []),
								info.title,
								...(info.genres || []),
								...(info.styles || []),
								...(info.labels?.map((label) => label.name) || []),
							]
								.join(" ")
								.toLowerCase();

							const matchingTerms = queryTerms.filter((term) =>
								searchableText.includes(term)
							).length;
							const relevanceScore = matchingTerms / queryTerms.length;

							return { ...release, relevanceScore };
						})
						.sort((a, b) => {
							const aRelevance = a.relevanceScore || 0;
							const bRelevance = b.relevanceScore || 0;
							if (aRelevance !== bRelevance) {
								return bRelevance - aRelevance;
							}
							if (a.rating !== b.rating) {
								return b.rating - a.rating;
							}
							return (
								new Date(b.date_added).getTime() -
								new Date(a.date_added).getTime()
							);
						});
				} else {
					// Sort by rating and date
					filteredReleases.sort((a, b) => {
						if (a.rating !== b.rating) {
							return b.rating - a.rating;
						}
						return (
							new Date(b.date_added).getTime() -
							new Date(a.date_added).getTime()
						);
					});
				}

				// Limit results
				const recommendations = filteredReleases.slice(0, limit);

				// Build response
				let text = `**Context-Aware Music Recommendations**\n\n`;

				if (
					genre ||
					decade ||
					similar_to ||
					query ||
					format ||
					moodGenres.length > 0
				) {
					text += `**Filters Applied:**\n`;
					if (genre) text += `• Genre: ${genre}\n`;
					if (decade) text += `• Decade: ${decade}\n`;
					if (format) text += `• Format: ${format}\n`;
					if (similar_to) text += `• Similar to: ${similar_to}\n`;
					if (query) text += `• Query: ${query}\n`;
					if (moodGenres.length > 0)
						text += `• Mood-based genres: ${moodGenres.slice(0, 5).join(", ")}\n`;
					text += `\n`;
				}

				if (moodInfo) {
					text += moodInfo;
				}

				text += `Found ${filteredReleases.length} matching releases in your collection (showing top ${recommendations.length}):\n\n`;

				if (recommendations.length === 0) {
					text += `No releases found matching your criteria. Try:\n`;
					text += `• Broadening your search terms\n`;
					text += `• Using different genres or decades\n`;
					text += `• Searching for specific artists you own\n`;
					text += `• Using mood descriptors like "mellow", "energetic", "melancholy"\n`;
					text += `• Trying contextual terms like "Sunday evening", "rainy day", "workout"\n`;
				} else {
					recommendations.forEach((release, index) => {
						const info = release.basic_information;
						const artists = info.artists.map((a) => a.name).join(", ");
						const formats = info.formats?.map((f) => f.name).join(", ") || "Unknown";
						const genres = info.genres?.join(", ") || "Unknown";
						const year = info.year || "Unknown";
						const rating = release.rating > 0 ? ` ⭐${release.rating}` : "";
						const relevance =
							query && "relevanceScore" in release
								? ` (${Math.round((release as ReleaseWithRelevance).relevanceScore! * 100)}% match)`
								: "";

						text += `${index + 1}. **${artists} - ${info.title}** (${year})${rating}${relevance}\n`;
						text += `   Format: ${formats} | Genres: ${genres}\n`;
						if (info.styles && info.styles.length > 0) {
							text += `   Styles: ${info.styles.join(", ")}\n`;
						}
						text += `   Release ID: ${release.id}\n\n`;
					});

					text += `**Tip:** Use the get_release tool with any Release ID for detailed information about specific albums.`;
				}

				return {
					content: [
						{
							type: "text",
							text,
						},
					],
				};
			} catch (error) {
				throw new Error(
					`Failed to get recommendations: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		}
	);

	/**
	 * Tool: get_cache_stats
	 * Get cache performance statistics
	 */
	server.tool(
		"get_cache_stats",
		"Get cache performance statistics including total entries, pending requests, and data type breakdown.",
		{},
		async () => {
			const { session, connectionId } = await getSessionContext();

			if (!session) {
				return {
					content: [
						{
							type: "text",
							text: generateAuthInstructions(connectionId),
						},
					],
				};
			}

			try {
				if (!cachedClient) {
					return {
						content: [
							{
								type: "text",
								text: "**Cache Statistics**\n\nCaching is not available - no KV storage configured. All requests go directly to the Discogs API.",
							},
						],
					};
				}

				const stats = await cachedClient.getCacheStats();

				let text = "**Cache Performance Statistics**\n\n";
				text += `📊 **Total Cache Entries:** ${stats.totalEntries}\n`;
				text += `⏳ **Pending Requests:** ${stats.pendingRequests}\n\n`;

				if (Object.keys(stats.entriesByType).length > 0) {
					text += "**Cached Data Types:**\n";
					for (const [type, count] of Object.entries(stats.entriesByType)) {
						text += `• ${type}: ${count} entries\n`;
					}
				} else {
					text += "**No cached data** - Cache is empty or recently cleared\n";
				}

				text += "\n**Cache Benefits:**\n";
				text += "• Reduced API calls to Discogs\n";
				text += "• Faster response times\n";
				text += "• Better rate limit compliance\n";
				text += "• Request deduplication for concurrent users\n";

				return {
					content: [
						{
							type: "text",
							text,
						},
					],
				};
			} catch (error) {
				throw new Error(
					`Failed to get cache stats: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		}
	);
}
