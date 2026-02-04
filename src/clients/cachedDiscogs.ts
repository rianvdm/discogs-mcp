/**
 * Cached wrapper for DiscogsClient
 * Implements smart caching to reduce API calls and rate limiting issues
 *
 * Key optimization: All tools that need the full collection (search, stats,
 * recommendations) share a single cached dataset via getCompleteCollection().
 * This means the first tool call in a session pays the cost of fetching all
 * pages, but subsequent calls (even with different queries/filters) use the
 * cached data with zero additional API calls.
 */

import {
	DiscogsClient,
	type DiscogsCollectionResponse,
	type DiscogsRelease,
	type DiscogsCollectionStats,
	type DiscogsSearchResponse,
	type DiscogsCollectionItem,
} from './discogs'
import { SmartCache, CacheKeys, createDiscogsCache } from '../utils/cache'

export class CachedDiscogsClient {
	private client: DiscogsClient
	private cache: SmartCache

	constructor(client: DiscogsClient, kv: KVNamespace) {
		this.client = client
		this.cache = createDiscogsCache(kv)
		// Set KV on the underlying client for persistent throttling
		this.client.setKV(kv)
	}

	/**
	 * Get detailed information about a specific release with caching
	 */
	async getRelease(
		releaseId: string,
		accessToken: string,
		accessTokenSecret?: string,
		consumerKey?: string,
		consumerSecret?: string,
	): Promise<DiscogsRelease> {
		const cacheKey = CacheKeys.release(releaseId)

		return this.cache.getOrFetch('releases', cacheKey, () =>
			this.client.getRelease(releaseId, accessToken, accessTokenSecret, consumerKey, consumerSecret),
		)
	}

	/**
	 * Search user's collection with intelligent caching
	 */
	async searchCollection(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		options: {
			query?: string
			page?: number
			per_page?: number
			sort?: 'added' | 'artist' | 'title' | 'year'
			sort_order?: 'asc' | 'desc'
		} = {},
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsCollectionResponse> {
		// Different caching strategies based on query type
		if (options.query) {
			// Search queries - shorter cache time since they're context-specific
			const cacheKey = CacheKeys.collectionSearch(username, options.query, options.page)

			return this.cache.getOrFetch('searches', cacheKey, () =>
				this.client.searchCollection(username, accessToken, accessTokenSecret, options, consumerKey, consumerSecret),
			)
		} else {
			// Collection browsing - longer cache time since collections don't change often
			const cacheKey = CacheKeys.collection(username, options.page, `${options.sort || 'default'}:${options.sort_order || 'desc'}`)

			return this.cache.getOrFetch(
				'collections',
				cacheKey,
				() => this.client.searchCollection(username, accessToken, accessTokenSecret, options, consumerKey, consumerSecret),
				{ maxAge: 20 * 60 }, // Override: refresh collection data if older than 20 minutes for browsing
			)
		}
	}

	/**
	 * Get user's collection statistics with caching
	 */
	async getCollectionStats(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsCollectionStats> {
		const cacheKey = CacheKeys.stats(username)

		return this.cache.getOrFetch('stats', cacheKey, () =>
			this.client.getCollectionStats(username, accessToken, accessTokenSecret, consumerKey, consumerSecret),
		)
	}

	/**
	 * Get user profile with caching
	 */
	async getUserProfile(
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<{ username: string; id: number }> {
		const cacheKey = CacheKeys.userProfile(accessToken) // Use token as unique identifier

		return this.cache.getOrFetch('userProfiles', cacheKey, () =>
			this.client.getUserProfile(accessToken, accessTokenSecret, consumerKey, consumerSecret),
		)
	}

	/**
	 * Search Discogs database with basic caching
	 */
	async searchDatabase(
		query: string,
		accessToken: string,
		accessTokenSecret?: string,
		options: {
			type?: 'release' | 'master' | 'artist' | 'label'
			page?: number
			per_page?: number
		} = {},
		consumerKey?: string,
		consumerSecret?: string,
	): Promise<DiscogsSearchResponse> {
		// Database searches are cached for shorter time since they may return different results
		const cacheKey = `${query}:${options.type || 'all'}:${options.page || 1}:${options.per_page || 50}`

		return this.cache.getOrFetch(
			'searches',
			cacheKey,
			() => this.client.searchDatabase(query, accessToken, accessTokenSecret, options, consumerKey, consumerSecret),
			{ maxAge: 10 * 60 }, // Database searches cached for only 10 minutes
		)
	}

	/**
	 * Get cache statistics
	 */
	async getCacheStats() {
		return this.cache.getStats()
	}

	/**
	 * Invalidate cache for a specific user
	 */
	async invalidateUserCache(username: string) {
		await Promise.all([
			this.cache.invalidate(`collections:${username}`),
			this.cache.invalidate(`searches:${username}`),
			this.cache.invalidate(`stats:${username}`),
		])
	}

	/**
	 * Preload essential data for a user (cache warming)
	 */
	async warmUserCache(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<void> {
		console.log(`Warming cache for user: ${username}`)

		try {
			// Preload first page of collection
			await this.searchCollection(username, accessToken, accessTokenSecret, { page: 1, per_page: 50 }, consumerKey, consumerSecret)

			// Preload user profile
			await this.getUserProfile(accessToken, accessTokenSecret, consumerKey, consumerSecret)

			console.log(`Cache warming completed for user: ${username}`)
		} catch (error) {
			console.error(`Cache warming failed for user: ${username}:`, error)
			// Don't throw - cache warming is optional
		}
	}

	/**
	 * Batch collection fetching with intelligent pagination
	 */
	/**
	 * Fetch the complete collection with intelligent pagination and caching.
	 *
	 * This is the primary method tools should use when they need access to the
	 * full collection (search, stats, recommendations). The complete result is
	 * cached for 45 minutes, so the first call pays the pagination cost but all
	 * subsequent calls return instantly from cache.
	 *
	 * For a 1000-item collection this costs ~11 API calls on cold cache, 0 on warm.
	 */
	async getCompleteCollection(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
		maxPages: number = 25, // Supports up to 2500 items at 100/page
	): Promise<DiscogsCollectionResponse> {
		const cacheKey = `${username}:complete:${maxPages}`

		return this.cache.getOrFetch(
			'collections',
			cacheKey,
			async () => {
				console.log(`Fetching complete collection for ${username} (max ${maxPages} pages)`)

				// Start with first page
				let allReleases: DiscogsCollectionItem[] = []
				let currentPage = 1
				let totalPages = 1

				do {
					const pageResult = await this.searchCollection(
						username,
						accessToken,
						accessTokenSecret,
						{ page: currentPage, per_page: 100 },
						consumerKey,
						consumerSecret,
					)

					allReleases = allReleases.concat(pageResult.releases)
					totalPages = Math.min(pageResult.pagination.pages, maxPages)
					currentPage++
				} while (currentPage <= totalPages)

				const wasTruncated = totalPages < (allReleases.length > 0 ? Math.ceil(allReleases.length / 100) : 1)
				if (wasTruncated) {
					console.log(`Collection truncated at ${maxPages} pages (${allReleases.length} items). Actual collection may be larger.`)
				}

				// Return in the same format as regular collection response
				return {
					pagination: {
						pages: totalPages,
						page: 1,
						per_page: allReleases.length,
						items: allReleases.length,
						urls: {},
					},
					releases: allReleases,
				}
			},
			{ maxAge: 45 * 60 }, // Cache complete collections for 45 minutes
		)
	}

	/**
	 * Convenience: get just the releases array from the complete collection.
	 * Useful for tools that need to filter/process all releases in-memory.
	 */
	async getCompleteCollectionReleases(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsCollectionItem[]> {
		const collection = await this.getCompleteCollection(username, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		return collection.releases
	}

	/**
	 * Compute collection statistics from an array of releases.
	 * This is a pure in-memory computation -- no API calls.
	 * Tools should call getCompleteCollectionReleases() first, then pass
	 * the result here. This avoids a separate pagination pass for stats.
	 */
	computeStatsFromReleases(releases: DiscogsCollectionItem[]): DiscogsCollectionStats {
		const stats: DiscogsCollectionStats = {
			totalReleases: releases.length,
			totalValue: 0,
			genreBreakdown: {},
			decadeBreakdown: {},
			formatBreakdown: {},
			labelBreakdown: {},
			averageRating: 0,
			ratedReleases: 0,
		}

		let totalRating = 0
		let ratedCount = 0

		for (const item of releases) {
			const release = item.basic_information

			for (const genre of release.genres || []) {
				stats.genreBreakdown[genre] = (stats.genreBreakdown[genre] || 0) + 1
			}

			if (release.year) {
				const decade = `${Math.floor(release.year / 10) * 10}s`
				stats.decadeBreakdown[decade] = (stats.decadeBreakdown[decade] || 0) + 1
			}

			for (const format of release.formats || []) {
				stats.formatBreakdown[format.name] = (stats.formatBreakdown[format.name] || 0) + 1
			}

			for (const label of release.labels || []) {
				stats.labelBreakdown[label.name] = (stats.labelBreakdown[label.name] || 0) + 1
			}

			if (item.rating > 0) {
				totalRating += item.rating
				ratedCount++
			}
		}

		stats.averageRating = ratedCount > 0 ? totalRating / ratedCount : 0
		stats.ratedReleases = ratedCount

		return stats
	}

	/**
	 * Cleanup old cache entries
	 */
	async cleanupCache(): Promise<void> {
		this.cache.cleanupPendingRequests()
	}
}

/**
 * Factory function to create cached client
 */
export function createCachedDiscogsClient(kv: KVNamespace): CachedDiscogsClient {
	const client = new DiscogsClient()
	return new CachedDiscogsClient(client, kv)
}

/**
 * Export singleton instance creator
 */
let cachedClientInstance: CachedDiscogsClient | null = null

export function getCachedDiscogsClient(kv: KVNamespace): CachedDiscogsClient {
	if (!cachedClientInstance) {
		cachedClientInstance = createCachedDiscogsClient(kv)
	}
	return cachedClientInstance
}
