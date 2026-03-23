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
	type DiscogsFolder,
	type DiscogsCustomField,
} from './discogs'
import { SmartCache, CacheKeys, createDiscogsCache } from '../utils/cache'

export class CachedDiscogsClient {
	private client: DiscogsClient
	private cache: SmartCache
	private readonly FETCH_LOCK_TTL = 120 // 2 minutes — long enough for a full collection fetch

	constructor(client: DiscogsClient, kv: KVNamespace) {
		this.client = client
		this.cache = createDiscogsCache(kv)
		// Set KV on the underlying client for persistent throttling
		this.client.setKV(kv)
	}

	/**
	 * Try to acquire a KV-based fetch lock. Returns true if lock was acquired.
	 * Prevents concurrent getCompleteCollection calls from doubling API usage.
	 * Uses a short TTL so locks auto-expire if the fetcher crashes.
	 */
	private async tryAcquireFetchLock(lockKey: string): Promise<boolean> {
		try {
			const kv = this.cache.getKV()
			const existing = await kv.get(lockKey)
			if (existing) {
				// Validate this is actually a lock value (timestamp string), not
				// unrelated data from a shared KV namespace.
				const lockTime = Number(existing)
				if (!isNaN(lockTime) && Date.now() - lockTime < this.FETCH_LOCK_TTL * 1000) {
					return false // Lock is held and not expired
				}
				// Not a valid lock or already expired — safe to acquire
			}
			// Small race window remains (read-then-write), but it's much narrower
			// than the throttle race. Worst case: two fetchers run, but the wider
			// throttle delay (1500ms) keeps combined rate within Discogs limits.
			await kv.put(lockKey, Date.now().toString(), {
				expirationTtl: this.FETCH_LOCK_TTL,
			})
			return true
		} catch {
			return true // Fail open: if KV errors, proceed with fetch
		}
	}

	private async releaseFetchLock(lockKey: string): Promise<void> {
		try {
			await this.cache.getKV().delete(lockKey)
		} catch {
			// Lock will auto-expire via TTL
		}
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
	 * Fetch the user's complete collection, assembling all paginated pages.
	 * Used by tools that need to operate on the full collection in-memory
	 * (search, stats, recommendations). The complete result is cached in KV,
	 * so the first call on cold cache pays the pagination cost; all subsequent
	 * calls return instantly.
	 *
	 * Time-budgeted: if `timeBudgetMs` is hit before all pages are fetched,
	 * returns a result with `partial: true`. Each page is cached individually
	 * by searchCollection(), so a retry call skips already-cached pages and
	 * continues from where the previous call left off.
	 */
	async getCompleteCollection(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
		maxPages: number = 50,
		timeBudgetMs: number = 35000,
	): Promise<DiscogsCollectionResponse & { partial?: boolean }> {
		const cacheKey = `${username}:complete:${maxPages}`

		// Return cached complete (non-partial) result immediately
		const cached = await this.cache.get<DiscogsCollectionResponse & { partial?: boolean }>('collections', cacheKey)
		if (cached && !cached.partial) {
			return cached
		}

		// Acquire fetch lock to prevent concurrent callers (e.g. search_collection
		// + get_recommendations in the same turn) from doubling API requests.
		const lockKey = `fetch-lock:collection:${username}`
		const acquiredLock = await this.tryAcquireFetchLock(lockKey)

		if (!acquiredLock) {
			// Another caller is already fetching — poll cache for the result.
			console.log(`Collection fetch already in progress for ${username}, waiting for cache...`)
			const pollStart = Date.now()
			const POLL_TIMEOUT_MS = Math.min(timeBudgetMs, 45000)
			const POLL_INTERVAL_MS = 2000

			while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
				const polled = await this.cache.get<DiscogsCollectionResponse & { partial?: boolean }>(
					'collections',
					cacheKey,
				)
				if (polled && !polled.partial) {
					return polled
				}
			}
			// Polling timed out — fall through and fetch (original lock will have expired)
		}

		try {
			console.log(`Fetching complete collection for ${username} (max ${maxPages} pages, budget ${timeBudgetMs}ms)`)
			const startTime = Date.now()
			let allReleases: DiscogsCollectionItem[] = []
			let currentPage = 1
			let totalPages = 1
			let actualTotalItems = 0
			let timedOut = false

			do {
				// Only check budget after the first page — we always fetch at least one page
				if (currentPage > 1 && Date.now() - startTime > timeBudgetMs) {
					console.log(`Time budget exceeded after ${currentPage - 1} pages (${Date.now() - startTime}ms)`)
					timedOut = true
					break
				}

				const pageResult = await this.searchCollection(
					username,
					accessToken,
					accessTokenSecret,
					{ page: currentPage, per_page: 100 },
					consumerKey,
					consumerSecret,
				)

				if (currentPage === 1) {
					actualTotalItems = pageResult.pagination.items
				}

				allReleases = allReleases.concat(pageResult.releases)
				totalPages = Math.min(pageResult.pagination.pages, maxPages)
				currentPage++
			} while (currentPage <= totalPages)

			const isTruncated = actualTotalItems > allReleases.length

			const result: DiscogsCollectionResponse & { partial?: boolean } = {
				pagination: {
					pages: totalPages,
					page: 1,
					per_page: allReleases.length,
					items: actualTotalItems || allReleases.length,
					urls: {} as { last?: string; next?: string },
				},
				releases: allReleases,
				// Only set `partial` when true — absence means complete (tests check `=== undefined`)
				...(timedOut ? { partial: true } : {}),
			}

			// Only cache complete results. Partial results are NOT cached at the
			// complete-collection level — individual pages are already cached by
			// searchCollection(), so the next call flies through them and continues.
			if (timedOut) {
				console.log(
					`Partial collection: fetched ${allReleases.length} of ${actualTotalItems} items (time budget exhausted).`,
				)
			} else {
				await this.cache.set('collections', cacheKey, result)

				if (isTruncated) {
					console.log(
						`Collection truncated: indexed ${allReleases.length} of ${actualTotalItems} items (hit ${maxPages}-page limit).`,
					)
				}
			}

			return result
		} finally {
			if (acquiredLock) {
				await this.releaseFetchLock(lockKey)
			}
		}
	}

	/**
	 * Convenience: get just the releases array from the complete collection.
	 * Passes through `timeBudgetMs` and propagates `partial` so the tool layer
	 * can apply its own retry loop.
	 */
	async getCompleteCollectionReleases(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
		timeBudgetMs: number = 35000,
	): Promise<{ releases: DiscogsCollectionItem[]; partial?: boolean }> {
		const collection = await this.getCompleteCollection(
			username, accessToken, accessTokenSecret, consumerKey, consumerSecret,
			50, timeBudgetMs,
		)
		return { releases: collection.releases, partial: collection.partial }
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

	// ──────────────────────────────────────────────
	// Collection write operations (pass-through with cache invalidation)
	// ──────────────────────────────────────────────

	async listFolders(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsFolder[]> {
		return this.client.listFolders(username, accessToken, accessTokenSecret, consumerKey, consumerSecret)
	}

	async createFolder(
		username: string,
		name: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsFolder> {
		const result = await this.client.createFolder(username, name, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		await this.invalidateUserCache(username)
		return result
	}

	async editFolder(
		username: string,
		folderId: number,
		name: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsFolder> {
		const result = await this.client.editFolder(username, folderId, name, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		await this.invalidateUserCache(username)
		return result
	}

	async deleteFolder(
		username: string,
		folderId: number,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<void> {
		await this.client.deleteFolder(username, folderId, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		await this.invalidateUserCache(username)
	}

	async addToFolder(
		username: string,
		folderId: number,
		releaseId: number,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<{ instance_id: number; resource_url: string }> {
		const result = await this.client.addToFolder(username, folderId, releaseId, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		await this.invalidateUserCache(username)
		return result
	}

	async removeFromFolder(
		username: string,
		folderId: number,
		releaseId: number,
		instanceId: number,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<void> {
		await this.client.removeFromFolder(username, folderId, releaseId, instanceId, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		await this.invalidateUserCache(username)
	}

	async editInstance(
		username: string,
		folderId: number,
		releaseId: number,
		instanceId: number,
		changes: { folder_id?: number; rating?: number },
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<void> {
		await this.client.editInstance(username, folderId, releaseId, instanceId, changes, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		await this.invalidateUserCache(username)
	}

	async listCustomFields(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsCustomField[]> {
		return this.client.listCustomFields(username, accessToken, accessTokenSecret, consumerKey, consumerSecret)
	}

	async editCustomFieldValue(
		username: string,
		folderId: number,
		releaseId: number,
		instanceId: number,
		fieldId: number,
		value: string,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<void> {
		await this.client.editCustomFieldValue(username, folderId, releaseId, instanceId, fieldId, value, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		// No cache invalidation needed — custom fields don't affect collection structure
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
