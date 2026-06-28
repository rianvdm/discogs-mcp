# Wantlist Support — Design

**Date:** 2026-06-27
**Status:** Draft
**Author:** Rian van der Merwe
**Issue:** [#36](https://github.com/rianvdm/discogs-mcp/issues/36)

> **Update (2026-06-27, post-live-test):** `rating` and `notes` on `add_to_wantlist` were **removed**. Live testing showed the `PUT` accepts them but neither field round-trips in `GET /wants`, and rating a release you don't own is a niche need (YAGNI). The tool is now a clean `release_id`-only add. The `DiscogsWant` type retains `rating`/`notes` since Discogs' response shape includes them; we simply don't set or display them. Sections below describing rating/notes reflect the original design.

## Problem

The server reads and mutates the **collection** but has no concept of the **wantlist** — Discogs' separate list of releases a user wants but doesn't own. An assistant can add a release to the collection, rate it, and move it between folders, but cannot answer "what's on my wantlist?" or "add this to my wantlist."

The wantlist is a clean addition: it's keyed directly by `release_id` (no folders, no instance IDs), so it's simpler than the collection write path already in place. No new infrastructure is needed — OAuth, the Durable Object rate limiter, KV caching, and pagination are all solved and reused as-is.

## Goals

* Read the authenticated user's wantlist (paginated).
* Add a release to the wantlist, with optional notes and rating.
* Remove a release from the wantlist.
* Match the existing collection-tool patterns end-to-end (client → cached wrapper → tool), so the code reads as a sibling of what's already there.

## Non-Goals

* **Ranked wantlist search** (`search_wantlist`) — start with plain paginated `get_wantlist`. Reuse the `searchRanking`/MiniSearch machinery later if the wantlist grows large enough to need it.
* **`discogs://wantlist` MCP resource** — possible follow-up mirroring `discogs://collection`. Tools cover the need first.
* **A separate edit tool** — the Discogs PUT endpoint is an idempotent upsert, so `add_to_wantlist` doubles as edit.
* **Marketplace / "wants value" / notifications** — separate Discogs features, out of scope.
* **Tool renaming** — naming matches the current `add_to_collection` style. A future entity-prefix rename ([#30](https://github.com/rianvdm/discogs-mcp/issues/30)) would re-prefix collection *and* wantlist tools together, in one batch.

## API Background

All three operations live under `/users/{username}/wants` and require OAuth (same auth path as collection writes).

| Operation | Method | Path | Notes |
|-----------|--------|------|-------|
| List | `GET` | `/users/{username}/wants?page=&per_page=` | Paginated. Response envelope `{ pagination, wants: [...] }`, same shape as the collection releases endpoint. Each want carries `id` (release id), `rating`, `notes`, `date_added`, `resource_url`, and a `basic_information` block identical to collection releases. |
| Add / update | `PUT` | `/users/{username}/wants/{release_id}` | Idempotent upsert. Optional `notes` and `rating` (0–5) in the JSON body. Adding an existing release updates its notes/rating. |
| Remove | `DELETE` | `/users/{username}/wants/{release_id}` | Returns `204 No Content`. |

Sources: [Discogs API docs](https://www.discogs.com/developers) (User Wantlist section), confirmed via [forum thread 188250](https://www.discogs.com/forum/thread/188250) and [thread 721235](https://www.discogs.com/forum/thread/721235) (PUT, not POST, for add).

> **Open verification:** the `rating` field on a want is asserted by the docs but must be confirmed against a live PUT during implementation. Mocked unit tests won't catch a `400`. If the live API rejects `rating`, drop it from `addToWantlist` and the tool schema — notes-only.

## Architecture

Four layers, each mirroring the equivalent collection code.

### 1. `src/clients/discogs.ts` — raw API methods

Three new methods, modeled on `addToFolder` / `removeFromFolder` / `editInstance`:

```ts
// GET /users/{username}/wants — paginated list
async getWantlist(
  username: string,
  accessToken: string,
  accessTokenSecret: string,
  options: { page?: number; per_page?: number },
  consumerKey: string,
  consumerSecret: string,
): Promise<DiscogsWantlistResponse>

// PUT /users/{username}/wants/{releaseId} — add or update (upsert)
async addToWantlist(
  username: string,
  releaseId: number,
  changes: { notes?: string; rating?: number },
  accessToken: string,
  accessTokenSecret: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<DiscogsWant>

// DELETE /users/{username}/wants/{releaseId} — remove
async removeFromWantlist(
  username: string,
  releaseId: number,
  accessToken: string,
  accessTokenSecret: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<void>
```

* All three build the URL, call `createOAuthHeader(url, method, …)`, and fetch via `discogsApiFetch` (which routes through the rate limiter when present).
* `addToWantlist` sends `Content-Type: application/json` and `JSON.stringify(changes)`, exactly like `editInstance`. When `changes` is empty it still PUTs (bare add).
* `removeFromWantlist` checks `response.ok` and does **not** parse the body (handles `204`), exactly like `removeFromFolder`.
* Error wrapping matches the house style: `throw new Error(\`Failed to … : ${…}\`)`.

### 2. `src/clients/cachedDiscogs.ts` — caching + invalidation

```ts
// Cached read
async getWantlist(username, accessToken, accessTokenSecret, options, consumerKey, consumerSecret) {
  const cacheKey = CacheKeys.wantlist(username, options.page)
  return this.cache.getOrFetch('wantlists', cacheKey, () =>
    this.client.getWantlist(username, accessToken, accessTokenSecret, options, consumerKey, consumerSecret),
  )
}

// Writes invalidate the wantlist cache only
async addToWantlist(username, releaseId, changes, …) {
  const result = await this.client.addToWantlist(username, releaseId, changes, …)
  await this.invalidateWantlistCache(username)
  return result
}

async removeFromWantlist(username, releaseId, …) {
  await this.client.removeFromWantlist(username, releaseId, …)
  await this.invalidateWantlistCache(username)
}

async invalidateWantlistCache(username: string) {
  await this.cache.invalidate(`wantlists:${username}`)
}
```

`invalidateWantlistCache` is kept separate from `invalidateUserCache` — wantlist and collection are independent, and a wantlist write should not evict collection/search/stats caches (or vice versa).

### 3. `src/utils/cache.ts` — new cache namespace

* Add `wantlists` to the `CacheConfig` interface, `DEFAULT_CACHE_CONFIG`, and `createDiscogsCache` with a **30-minute TTL** (shorter than `collections`' 4h — wantlists change more often and can be edited from the Discogs UI outside this server; writes invalidate anyway).
* Add the key factory:

```ts
wantlist: (username: string, page?: number) => `${username}:${page || 'all'}`,
```

The `wantlists:${username}` invalidation prefix matches every page key for that user.

### 4. `src/mcp/tools/authenticated.ts` — tool registrations

Three `server.tool(...)` definitions using the established handler shape (`getSessionContext()` → auth guard via `generateAuthInstructions` → `getProfileAndSetThrottle(session)` → cached client call → `buildNextSteps([...])` → text response).

| Tool | Zod schema | Behavior |
|------|-----------|----------|
| `get_wantlist` | `page: z.number().optional().default(1)`, `per_page: z.number().optional().default(50)` | Lists wants; summarizes count + pagination in the text response. |
| `add_to_wantlist` | `release_id: z.number()`, `notes: z.string().optional()`, `rating: z.number().min(0).max(5).optional()` | Upsert. Reports whether notes/rating were set. |
| `remove_from_wantlist` | `release_id: z.number()` | Removes; confirms in text. |

**Next-step chaining** (via `buildNextSteps`):

* `add_to_wantlist` → `get_release` (full metadata), `get_wantlist` (confirm it's there).
* `get_wantlist` → `add_to_collection` (move a want into the collection once acquired), `get_release`.
* `remove_from_wantlist` → `get_wantlist` (confirm it's gone).

### 5. Types

Add to the existing Discogs types (alongside `DiscogsCollectionResponse`):

```ts
interface DiscogsWant {
  id: number                       // release id
  rating: number
  notes?: string
  date_added: string
  resource_url: string
  basic_information: DiscogsBasicInformation  // reuse existing collection type
}

interface DiscogsWantlistResponse {
  pagination: DiscogsPagination     // reuse existing
  wants: DiscogsWant[]
}
```

Reuse the existing `basic_information` and `pagination` types — do not duplicate them.

## Data Flow

```
get_wantlist tool
  → cachedDiscogs.getWantlist (KV: wantlists:{user}:{page}, 30m TTL)
    → discogs.getWantlist → GET /users/{user}/wants → DiscogsWantlistResponse

add_to_wantlist tool
  → cachedDiscogs.addToWantlist
    → discogs.addToWantlist → PUT /users/{user}/wants/{id}
    → invalidate wantlists:{user}

remove_from_wantlist tool
  → cachedDiscogs.removeFromWantlist
    → discogs.removeFromWantlist → DELETE /users/{user}/wants/{id} (204)
    → invalidate wantlists:{user}
```

## Error Handling

Identical to the collection tools:

* **Unauthenticated** — tool returns `generateAuthInstructions(connectionId)` instead of erroring.
* **API failure** — client method wraps the HTTP error (`HTTP {status}: {body}`) and the tool rethrows with a tool-level prefix.
* **Rate limit** — handled upstream by `discogsApiFetch` → rate limiter; no tool-specific handling.

## Testing

Test-first, per layer, mirroring existing write-path coverage:

* **`test/clients/discogs-write.test.ts`** — `addToWantlist` (PUT method, JSON body, success), `removeFromWantlist` (DELETE, `204` handled without body parse), and `getWantlist` (pagination params, response parsing). Assert the OAuth header is built with the correct HTTP method.
* **`test/clients/cachedDiscogs-write.test.ts`** — `addToWantlist`/`removeFromWantlist` call `invalidateWantlistCache`; `getWantlist` populates and reads the `wantlists` namespace; collection caches are untouched by wantlist writes.
* **Tool registration** — the three tools register, enforce the auth guard, and return expected text on the happy path (follow the existing authenticated-tool tests).
* **Live smoke check (manual, pre-merge)** — one real `add_to_wantlist` with a `rating` against the live Discogs API to confirm the field is accepted. This is the gate for keeping `rating` in the schema.

## Docs

* `README.md` — add `get_wantlist`, `add_to_wantlist`, `remove_from_wantlist` rows to the authenticated-tools table.
* Server "recommended path" instructions (MCP server description) — add a wantlist line so the tools surface in the suggested chaining.

## Effort

Small–medium. No new infrastructure; this is three endpoints pattern-matched onto existing rails (auth, rate limiting, caching, pagination), plus tests and docs.
