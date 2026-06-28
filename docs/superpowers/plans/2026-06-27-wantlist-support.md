# Wantlist Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `get_wantlist`, `add_to_wantlist`, and `remove_from_wantlist` MCP tools so an assistant can read and mutate the user's Discogs wantlist.

**Architecture:** Three layers mirroring the existing collection write path — raw API methods in `DiscogsClient` (`src/clients/discogs.ts`), cached wrappers + invalidation in `CachedDiscogsClient` (`src/clients/cachedDiscogs.ts`) behind a new `wantlists` KV cache namespace, and three `server.tool(...)` registrations in `src/mcp/tools/authenticated.ts`. The wantlist is keyed by `release_id` (no folders/instances), and `add_to_wantlist` is a `PUT` upsert that doubles as edit.

**Tech Stack:** TypeScript, Cloudflare Workers, `@modelcontextprotocol/sdk`, Zod, `vitest` + `@cloudflare/vitest-pool-workers`. OAuth 1.0a, Durable Object rate limiter, and KV `SmartCache` are pre-existing and reused unchanged.

**Spec:** `docs/superpowers/specs/2026-06-27-wantlist-support-design.md`
**Issue:** [#36](https://github.com/rianvdm/discogs-mcp/issues/36)

## Global Constraints

- **Naming:** match the current `add_to_collection` style — `get_wantlist` / `add_to_wantlist` / `remove_from_wantlist`. No entity-prefix rename (that is #30, batched separately).
- **Both clients expose the same signatures:** tool handlers call `client` typed `CachedDiscogsClient | DiscogsClient`, so the three wantlist methods must exist on *both* classes with identical signatures.
- **DRY types:** reuse `DiscogsCollectionItem['basic_information']` and `DiscogsCollectionResponse['pagination']` via indexed access — do not redefine those shapes.
- **Endpoints:** `GET /users/{username}/wants` (paginated), `PUT /users/{username}/wants/{release_id}` (upsert, JSON body `{notes?, rating?}`), `DELETE /users/{username}/wants/{release_id}` (returns 204).
- **`rating` is provisional:** the live Discogs API must accept `rating` on a want. Mocked tests pass regardless; the manual smoke check in Final Verification is the gate. If the live `PUT` returns 400 on `rating`, remove `rating` from `addToWantlist`'s `changes` type and from the `add_to_wantlist` tool schema.
- **Error style:** every client method wraps failures as `throw new Error(\`Failed to … : ${error instanceof Error ? error.message : 'Unknown error'}\`)`. DELETE checks `response.ok` and does not parse the body.
- **Commit after each task.**

---

### Task 1: Wantlist types + raw client methods

**Files:**
- Modify: `src/clients/discogs.ts` (add two interfaces after line 93; add three methods before the `DiscogsClient` class closing brace, after `editCustomFieldValue`)
- Test: `test/clients/discogs-write.test.ts` (append a new `describe` block)

**Interfaces:**
- Produces:
  - `interface DiscogsWant { id: number; rating: number; notes?: string; date_added: string; resource_url: string; basic_information: DiscogsCollectionItem['basic_information'] }`
  - `interface DiscogsWantlistResponse { pagination: DiscogsCollectionResponse['pagination']; wants: DiscogsWant[] }`
  - `DiscogsClient.getWantlist(username, accessToken, accessTokenSecret, options: { page?: number; per_page?: number }, consumerKey, consumerSecret): Promise<DiscogsWantlistResponse>`
  - `DiscogsClient.addToWantlist(username, releaseId: number, changes: { notes?: string; rating?: number }, accessToken, accessTokenSecret, consumerKey, consumerSecret): Promise<DiscogsWant>`
  - `DiscogsClient.removeFromWantlist(username, releaseId: number, accessToken, accessTokenSecret, consumerKey, consumerSecret): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to the end of `test/clients/discogs-write.test.ts` (the file already defines `discogsClient`, `auth`, `mockFetch`, `mockOk`, `mock204`):

```ts
describe('Wantlist operations', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	const basicInfo = (id: number, title: string, year: number) => ({
		id,
		title,
		year,
		resource_url: '',
		thumb: '',
		cover_image: '',
		formats: [],
		labels: [],
		artists: [{ name: 'Some Artist', id: 1 }],
		genres: [],
		styles: [],
	})

	it('getWantlist returns wants + pagination and hits the wants endpoint', async () => {
		mockOk({
			pagination: { pages: 1, page: 1, per_page: 50, items: 2, urls: {} },
			wants: [
				{ id: 111, rating: 0, date_added: '2026-01-01', resource_url: '', basic_information: basicInfo(111, 'Album A', 2001) },
				{ id: 222, rating: 4, notes: 'want the repress', date_added: '2026-02-01', resource_url: '', basic_information: basicInfo(222, 'Album B', 2002) },
			],
		})

		const result = await discogsClient.getWantlist(
			auth.username,
			auth.accessToken,
			auth.accessTokenSecret,
			{ page: 1, per_page: 50 },
			auth.consumerKey,
			auth.consumerSecret,
		)

		expect(result.wants).toHaveLength(2)
		expect(result.wants[1].notes).toBe('want the repress')
		expect(result.pagination.items).toBe(2)

		const calledUrl = mockFetch.mock.calls[0][0] as string
		expect(calledUrl).toContain('/users/testuser/wants?')
		expect(calledUrl).toContain('page=1')
		expect(calledUrl).toContain('per_page=50')
	})

	it('addToWantlist PUTs the changes body and returns the want', async () => {
		mockOk({ id: 333, rating: 5, notes: 'grail', date_added: '2026-03-01', resource_url: '', basic_information: basicInfo(333, 'Album C', 2003) })

		const result = await discogsClient.addToWantlist(
			auth.username,
			333,
			{ notes: 'grail', rating: 5 },
			auth.accessToken,
			auth.accessTokenSecret,
			auth.consumerKey,
			auth.consumerSecret,
		)

		expect(result.id).toBe(333)
		const [calledUrl, init] = mockFetch.mock.calls[0]
		expect(calledUrl).toBe('https://api.discogs.com/users/testuser/wants/333')
		expect(init.method).toBe('PUT')
		expect(JSON.parse(init.body as string)).toEqual({ notes: 'grail', rating: 5 })
	})

	it('removeFromWantlist DELETEs and resolves on 204', async () => {
		mock204()

		await expect(
			discogsClient.removeFromWantlist(auth.username, 333, auth.accessToken, auth.accessTokenSecret, auth.consumerKey, auth.consumerSecret),
		).resolves.toBeUndefined()

		const [calledUrl, init] = mockFetch.mock.calls[0]
		expect(calledUrl).toBe('https://api.discogs.com/users/testuser/wants/333')
		expect(init.method).toBe('DELETE')
	})

	it('wraps errors with a descriptive message', async () => {
		mockFetch.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(
			discogsClient.addToWantlist(auth.username, 333, {}, auth.accessToken, auth.accessTokenSecret, auth.consumerKey, auth.consumerSecret),
		).rejects.toThrow('Failed to add to wantlist')
	})
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/rian/git/discogs-mcp && npx vitest run test/clients/discogs-write.test.ts -t "Wantlist operations"`
Expected: FAIL — `discogsClient.getWantlist is not a function` (and the other two methods undefined).

- [ ] **Step 3: Add the types**

In `src/clients/discogs.ts`, immediately after the `DiscogsCollectionResponse` interface (ends line 93) and before `export interface DiscogsSearchResponse` (line 95):

```ts
export interface DiscogsWant {
	id: number // release id
	rating: number
	notes?: string
	date_added: string
	resource_url: string
	basic_information: DiscogsCollectionItem['basic_information']
}

export interface DiscogsWantlistResponse {
	pagination: DiscogsCollectionResponse['pagination']
	wants: DiscogsWant[]
}
```

- [ ] **Step 4: Add the three client methods**

In `src/clients/discogs.ts`, inside the `DiscogsClient` class, after the `editCustomFieldValue` method and before the class's closing `}`:

```ts
	/**
	 * Get the authenticated user's wantlist (paginated)
	 */
	async getWantlist(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		options: { page?: number; per_page?: number } = {},
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsWantlistResponse> {
		const params = new URLSearchParams()
		if (options.page) params.append('page', options.page.toString())
		if (options.per_page) params.append('per_page', options.per_page.toString())

		const qs = params.toString()
		const url = `${this.baseUrl}/users/${username}/wants${qs ? `?${qs}` : ''}`
		const authHeader = await this.createOAuthHeader(url, 'GET', accessToken, accessTokenSecret, consumerKey, consumerSecret)

		try {
			const response = await this.discogsApiFetch(url, {
				method: 'GET',
				headers: {
					Authorization: authHeader,
					'User-Agent': this.userAgent,
				},
			})
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${await response.text()}`)
			}
			return response.json()
		} catch (error) {
			throw new Error(`Failed to fetch wantlist: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	/**
	 * Add a release to the wantlist, or update its notes/rating (PUT upsert)
	 */
	async addToWantlist(
		username: string,
		releaseId: number,
		changes: { notes?: string; rating?: number },
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsWant> {
		const url = `${this.baseUrl}/users/${username}/wants/${releaseId}`
		const authHeader = await this.createOAuthHeader(url, 'PUT', accessToken, accessTokenSecret, consumerKey, consumerSecret)

		try {
			const response = await this.discogsApiFetch(url, {
				method: 'PUT',
				headers: {
					Authorization: authHeader,
					'User-Agent': this.userAgent,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(changes),
			})
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${await response.text()}`)
			}
			return response.json()
		} catch (error) {
			throw new Error(`Failed to add to wantlist: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	/**
	 * Remove a release from the wantlist
	 */
	async removeFromWantlist(
		username: string,
		releaseId: number,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<void> {
		const url = `${this.baseUrl}/users/${username}/wants/${releaseId}`
		const authHeader = await this.createOAuthHeader(url, 'DELETE', accessToken, accessTokenSecret, consumerKey, consumerSecret)

		try {
			const response = await this.discogsApiFetch(url, {
				method: 'DELETE',
				headers: {
					Authorization: authHeader,
					'User-Agent': this.userAgent,
				},
			})
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${await response.text()}`)
			}
		} catch (error) {
			throw new Error(`Failed to remove from wantlist: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/rian/git/discogs-mcp && npx vitest run test/clients/discogs-write.test.ts -t "Wantlist operations"`
Expected: PASS — 4 passed.

- [ ] **Step 6: Commit**

```bash
cd /Users/rian/git/discogs-mcp
git add src/clients/discogs.ts test/clients/discogs-write.test.ts
git commit -m "feat(client): wantlist get/add/remove API methods (#36)"
```

---

### Task 2: Cache namespace + cached wrappers

**Files:**
- Modify: `src/utils/cache.ts` (add `wantlists` to `CacheConfig`, `DEFAULT_CACHE_CONFIG`, `createDiscogsCache`; add `CacheKeys.wantlist`)
- Modify: `src/clients/cachedDiscogs.ts` (extend the `./discogs` type import; add four methods)
- Test: `test/clients/cachedDiscogs-write.test.ts` (extend `makeMockClient`; append a `describe` block)

**Interfaces:**
- Consumes: `DiscogsClient.getWantlist` / `addToWantlist` / `removeFromWantlist`, types `DiscogsWant` / `DiscogsWantlistResponse` (Task 1).
- Produces:
  - `CacheKeys.wantlist(username: string, page?: number): string` → `\`${username}:${page || 'all'}\``
  - `CachedDiscogsClient.getWantlist(username, accessToken, accessTokenSecret, options: { page?: number; per_page?: number }, consumerKey, consumerSecret): Promise<DiscogsWantlistResponse>`
  - `CachedDiscogsClient.addToWantlist(username, releaseId, changes, accessToken, accessTokenSecret, consumerKey, consumerSecret): Promise<DiscogsWant>`
  - `CachedDiscogsClient.removeFromWantlist(username, releaseId, accessToken, accessTokenSecret, consumerKey, consumerSecret): Promise<void>`
  - `CachedDiscogsClient.invalidateWantlistCache(username: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

In `test/clients/cachedDiscogs-write.test.ts`, add these three lines to the object returned by `makeMockClient()` (after `editCustomFieldValue`):

```ts
		getWantlist: vi.fn(async () => ({ pagination: { pages: 1, page: 1, per_page: 50, items: 0, urls: {} }, wants: [] })),
		addToWantlist: vi.fn(async () => ({ id: 333, rating: 5, date_added: '', resource_url: '', basic_information: { id: 333, title: 'Album C', year: 2003, resource_url: '', thumb: '', cover_image: '', formats: [], labels: [], artists: [], genres: [], styles: [] } })),
		removeFromWantlist: vi.fn(async () => undefined),
```

Add this import at the top of the file (below the existing imports):

```ts
import { CacheKeys } from '../../src/utils/cache'
```

Append this `describe` block before the file's final closing `})`:

```ts
	describe('wantlist operations', () => {
		it('CacheKeys.wantlist formats username + page', () => {
			expect(CacheKeys.wantlist('user', 2)).toBe('user:2')
			expect(CacheKeys.wantlist('user')).toBe('user:all')
		})

		it('getWantlist passes through and does NOT invalidate', async () => {
			const wlSpy = vi.spyOn(cached, 'invalidateWantlistCache').mockResolvedValue(undefined)

			const result = await cached.getWantlist('user', 'token', 'secret', { page: 1 }, 'key', 'csecret')

			expect(result.wants).toEqual([])
			expect((mockClient as any).getWantlist).toHaveBeenCalledOnce()
			expect(wlSpy).not.toHaveBeenCalled()
		})

		it('addToWantlist invalidates the wantlist cache', async () => {
			const wlSpy = vi.spyOn(cached, 'invalidateWantlistCache').mockResolvedValue(undefined)

			const result = await cached.addToWantlist('user', 333, { rating: 5 }, ...a)

			expect(result.id).toBe(333)
			expect(wlSpy).toHaveBeenCalledWith('user')
		})

		it('removeFromWantlist invalidates the wantlist cache', async () => {
			const wlSpy = vi.spyOn(cached, 'invalidateWantlistCache').mockResolvedValue(undefined)

			await cached.removeFromWantlist('user', 333, ...a)

			expect(wlSpy).toHaveBeenCalledWith('user')
		})
	})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/rian/git/discogs-mcp && npx vitest run test/clients/cachedDiscogs-write.test.ts -t "wantlist operations"`
Expected: FAIL — `CacheKeys.wantlist is not a function` / `cached.getWantlist is not a function`.

- [ ] **Step 3: Add the cache namespace and key factory**

In `src/utils/cache.ts`:

(a) Add `wantlists` to the `CacheConfig` interface (after `userProfiles`, line 21):

```ts
	userProfiles: number // 6 hours
	wantlists: number // 30 minutes
```

(b) Add to `DEFAULT_CACHE_CONFIG` (after the `userProfiles` line, ~line 29):

```ts
	userProfiles: 6 * 60 * 60, // 6 hours in seconds
	wantlists: 30 * 60, // 30 minutes in seconds
```

(c) Add to the config object inside `createDiscogsCache` (after the `userProfiles` line, ~line 314):

```ts
		userProfiles: 6 * 60 * 60, // User profiles rarely change
		wantlists: 30 * 60, // Wantlists change more often than collections; invalidated on write
```

(d) Add to the `CacheKeys` object (after the `stats` entry, ~line 299):

```ts
	wantlist: (username: string, page?: number) => `${username}:${page || 'all'}`,
```

- [ ] **Step 4: Add the cached wrappers**

In `src/clients/cachedDiscogs.ts`, extend the type import from `./discogs` (lines 12–21) by adding these two lines inside the braces:

```ts
	type DiscogsWant,
	type DiscogsWantlistResponse,
```

Then add these four methods to the `CachedDiscogsClient` class, after the `invalidateUserCache` method (~line 212):

```ts
	/**
	 * Get the user's wantlist with caching
	 */
	async getWantlist(
		username: string,
		accessToken: string,
		accessTokenSecret: string,
		options: { page?: number; per_page?: number } = {},
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsWantlistResponse> {
		const cacheKey = CacheKeys.wantlist(username, options.page)
		return this.cache.getOrFetch('wantlists', cacheKey, () =>
			this.client.getWantlist(username, accessToken, accessTokenSecret, options, consumerKey, consumerSecret),
		)
	}

	/**
	 * Add or update a wantlist item, then invalidate the wantlist cache
	 */
	async addToWantlist(
		username: string,
		releaseId: number,
		changes: { notes?: string; rating?: number },
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<DiscogsWant> {
		const result = await this.client.addToWantlist(username, releaseId, changes, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		await this.invalidateWantlistCache(username)
		return result
	}

	/**
	 * Remove a wantlist item, then invalidate the wantlist cache
	 */
	async removeFromWantlist(
		username: string,
		releaseId: number,
		accessToken: string,
		accessTokenSecret: string,
		consumerKey: string,
		consumerSecret: string,
	): Promise<void> {
		await this.client.removeFromWantlist(username, releaseId, accessToken, accessTokenSecret, consumerKey, consumerSecret)
		await this.invalidateWantlistCache(username)
	}

	/**
	 * Invalidate cached wantlist pages for a user
	 */
	async invalidateWantlistCache(username: string) {
		await this.cache.invalidate(`wantlists:${username}`)
	}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/rian/git/discogs-mcp && npx vitest run test/clients/cachedDiscogs-write.test.ts`
Expected: PASS — all existing tests plus the 4 new wantlist assertions pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/rian/git/discogs-mcp
git add src/utils/cache.ts src/clients/cachedDiscogs.ts test/clients/cachedDiscogs-write.test.ts
git commit -m "feat(cache): wantlists cache namespace + cached wantlist wrappers (#36)"
```

---

### Task 3: MCP tools + docs

**Files:**
- Modify: `src/mcp/tools/authenticated.ts` (three `server.tool(...)` registrations, before the closing brace of `registerAuthenticatedTools`)
- Modify: `src/mcp/server.ts` (one line in the `instructions` array)
- Modify: `README.md` (new "Wantlist" subsection in the authenticated tools section)
- Test: `test/mcp/tools/wantlistTools.test.ts` (new — registration test)

**Interfaces:**
- Consumes: `client.getWantlist` / `addToWantlist` / `removeFromWantlist` (resolves to `CachedDiscogsClient` in production), `getSessionContext`, `getProfileAndSetThrottle`, `generateAuthInstructions`, `buildNextSteps` (all already in scope in `authenticated.ts`).
- Produces: registered MCP tools `get_wantlist`, `add_to_wantlist`, `remove_from_wantlist`.

> **Note on test strategy:** the existing collection write *tools* have no per-handler unit tests (only the client and cached layers are unit-tested). Match that — Task 3's automated coverage is a registration test plus typecheck/lint/build. The handler behavior against the real API is covered by the manual smoke check in Final Verification.

- [ ] **Step 1: Write the failing registration test**

Create `test/mcp/tools/wantlistTools.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { registerAuthenticatedTools } from '../../../src/mcp/tools/authenticated'

describe('wantlist tool registration', () => {
	it('registers get_wantlist, add_to_wantlist, and remove_from_wantlist', () => {
		const registered: string[] = []
		const server = {
			tool: vi.fn((name: string) => {
				registered.push(name)
			}),
			prompt: vi.fn(),
			resource: vi.fn(),
		} as any
		const env = { DISCOGS_CONSUMER_KEY: 'k', DISCOGS_CONSUMER_SECRET: 's' } as any
		const getSessionContext = async () => ({ session: null, connectionId: undefined }) as any

		registerAuthenticatedTools(server, env, getSessionContext)

		expect(registered).toContain('get_wantlist')
		expect(registered).toContain('add_to_wantlist')
		expect(registered).toContain('remove_from_wantlist')
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rian/git/discogs-mcp && npx vitest run test/mcp/tools/wantlistTools.test.ts`
Expected: FAIL — the three names are not yet registered (assertion fails).

- [ ] **Step 3: Register the three tools**

In `src/mcp/tools/authenticated.ts`, add the following inside `registerAuthenticatedTools`, after the last existing `server.tool(...)` block and before the function's closing `}`:

```ts
	/**
	 * Tool: get_wantlist
	 * List the authenticated user's Discogs wantlist (paginated)
	 */
	server.tool(
		'get_wantlist',
		"List releases on your Discogs wantlist (releases you want but don't own). Paginated.",
		{
			page: z.number().optional().default(1).describe('Page number (default: 1)'),
			per_page: z.number().optional().default(50).describe('Items per page, max 100 (default: 50)'),
		},
		async ({ page, per_page }) => {
			const { session, connectionId } = await getSessionContext()
			if (!session) {
				return { content: [{ type: 'text', text: generateAuthInstructions(connectionId) }] }
			}
			try {
				const userProfile = await getProfileAndSetThrottle(session)
				const result = await client.getWantlist(
					userProfile.username,
					session.accessToken,
					session.accessTokenSecret,
					{ page, per_page },
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const lines = result.wants.map(w => {
					const artists = w.basic_information.artists?.map(a => a.name).join(', ') || 'Unknown'
					return `- ${artists} — ${w.basic_information.title} (${w.basic_information.year || 'n/a'}) [release ${w.id}]`
				})
				const header = `Wantlist — ${result.pagination.items} item(s), page ${result.pagination.page}/${result.pagination.pages}`
				const nextSteps = buildNextSteps([
					{ tool: 'add_to_collection', args: 'release_id=<id>', hint: 'move a want into your collection once you acquire it' },
					{ tool: 'get_release', args: 'release_id=<id>', hint: 'pull tracklist and full metadata for a want' },
				])
				return {
					content: [{ type: 'text', text: `${header}\n${lines.join('\n') || '(empty)'}${nextSteps}` }],
				}
			} catch (error) {
				throw new Error(`Failed to get wantlist: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: add_to_wantlist
	 * Add a release to the wantlist, or update its notes/rating (PUT upsert)
	 */
	server.tool(
		'add_to_wantlist',
		'Add a release to your Discogs wantlist. If it is already on the wantlist, updates its notes/rating. Rating is 0–5.',
		{
			release_id: z.number().describe('The Discogs release ID to want'),
			notes: z.string().optional().describe('Optional private note about this want'),
			rating: z.number().min(0).max(5).optional().describe('Optional rating, 0 (none) to 5 stars'),
		},
		async ({ release_id, notes, rating }) => {
			const { session, connectionId } = await getSessionContext()
			if (!session) {
				return { content: [{ type: 'text', text: generateAuthInstructions(connectionId) }] }
			}
			try {
				const userProfile = await getProfileAndSetThrottle(session)
				const changes: { notes?: string; rating?: number } = {}
				if (notes !== undefined) changes.notes = notes
				if (rating !== undefined) changes.rating = rating

				const result = await client.addToWantlist(
					userProfile.username,
					release_id,
					changes,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)

				const title = result?.basic_information?.title ?? `release ${release_id}`
				const extras = [notes !== undefined ? 'notes set' : null, rating !== undefined ? `rating ${rating}` : null]
					.filter(Boolean)
					.join(', ')
				const nextSteps = buildNextSteps([
					{ tool: 'get_wantlist', args: '', hint: 'confirm the release is on your wantlist' },
					{ tool: 'get_release', args: `release_id=${release_id}`, hint: 'pull tracklist and full metadata' },
				])
				return {
					content: [{ type: 'text', text: `Added ${title} to your wantlist${extras ? ` (${extras})` : ''}${nextSteps}` }],
				}
			} catch (error) {
				throw new Error(`Failed to add to wantlist: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)

	/**
	 * Tool: remove_from_wantlist
	 * Remove a release from the wantlist
	 */
	server.tool(
		'remove_from_wantlist',
		'Remove a release from your Discogs wantlist.',
		{
			release_id: z.number().describe('The Discogs release ID to remove from the wantlist'),
		},
		async ({ release_id }) => {
			const { session, connectionId } = await getSessionContext()
			if (!session) {
				return { content: [{ type: 'text', text: generateAuthInstructions(connectionId) }] }
			}
			try {
				const userProfile = await getProfileAndSetThrottle(session)
				await client.removeFromWantlist(
					userProfile.username,
					release_id,
					session.accessToken,
					session.accessTokenSecret,
					env.DISCOGS_CONSUMER_KEY,
					env.DISCOGS_CONSUMER_SECRET,
				)
				const nextSteps = buildNextSteps([{ tool: 'get_wantlist', args: '', hint: 'confirm the release is gone' }])
				return {
					content: [{ type: 'text', text: `Removed release ${release_id} from your wantlist${nextSteps}` }],
				}
			} catch (error) {
				throw new Error(`Failed to remove from wantlist: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		},
	)
```

- [ ] **Step 4: Run the registration test to verify it passes**

Run: `cd /Users/rian/git/discogs-mcp && npx vitest run test/mcp/tools/wantlistTools.test.ts`
Expected: PASS — 1 passed.

- [ ] **Step 5: Add the server instructions line**

In `src/mcp/server.ts`, in the `instructions` array, add a line directly after the "Mutations on a known release" line (line 79):

```ts
		'- Wantlist (releases you want but don\'t own): `get_wantlist` to browse, `add_to_wantlist` (add or update notes/rating), `remove_from_wantlist`.',
```

- [ ] **Step 6: Add the README subsection**

In `README.md`, after the **Collection management** table (right after the `rate_release` row, before the **Folders** heading), insert:

```md
**Wantlist**

| Tool                   | Description                                                     |
| ---------------------- | -------------------------------------------------------------- |
| `get_wantlist`         | List releases on your wantlist (paginated)                     |
| `add_to_wantlist`      | Add a release to your wantlist, or update its notes/rating     |
| `remove_from_wantlist` | Remove a release from your wantlist                            |
```

- [ ] **Step 7: Typecheck, lint, and re-run the registration test**

Run: `cd /Users/rian/git/discogs-mcp && npm run build && npm run lint && npx vitest run test/mcp/tools/wantlistTools.test.ts`
Expected: build succeeds (dry-run bundle, no TS errors), lint clean, test passes.

- [ ] **Step 8: Commit**

```bash
cd /Users/rian/git/discogs-mcp
git add src/mcp/tools/authenticated.ts src/mcp/server.ts README.md test/mcp/tools/wantlistTools.test.ts
git commit -m "feat(tools): get/add/remove_wantlist MCP tools + docs (#36)"
```

---

## Final Verification

- [ ] **Full test suite:** `cd /Users/rian/git/discogs-mcp && npx vitest run` → all green.
- [ ] **Lint + build:** `npm run lint && npm run build` → clean.
- [ ] **Manual live smoke check (the `rating` gate):** with real Discogs credentials (`.dev.vars`), run `npm run dev`, authenticate, and call `add_to_wantlist` with `{ release_id: <a real id>, notes: "test", rating: 4 }`. Confirm a `200`, then `get_wantlist` shows it, then `remove_from_wantlist` clears it.
  - If the live `PUT` returns `400` because of `rating`: remove `rating` from the `changes` type in `addToWantlist` (`src/clients/discogs.ts` + `src/clients/cachedDiscogs.ts`) and from the `add_to_wantlist` tool schema and handler (`src/mcp/tools/authenticated.ts`), drop the `rating` assertion from the Task 1 test, and re-run the suite. Notes-only.
- [ ] **Open the PR** against `main` once green.

## Self-Review (completed during planning)

- **Spec coverage:** every spec section maps to a task — client methods + types (Task 1), cache namespace + cached wrappers + invalidation (Task 2), tool registrations + server instructions + README (Task 3), `discogs://wantlist` resource and ranked search explicitly deferred (Non-Goals), `rating` live-check gated (Final Verification).
- **Placeholder scan:** no TBD/TODO; every code step is complete.
- **Type consistency:** `getWantlist`/`addToWantlist`/`removeFromWantlist` signatures and the `DiscogsWant`/`DiscogsWantlistResponse`/`CacheKeys.wantlist`/`invalidateWantlistCache` names are identical across Tasks 1–3.
