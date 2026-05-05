// ABOUTME: Resolves Discogs usernames to numeric user IDs via the public
// ABOUTME: GET /users/{username} endpoint, with module-level + KV caching.
import { fetchWithRetry } from '../utils/retry'
import { SERVER_VERSION } from '../version'

const USER_AGENT = `discogs-mcp/${SERVER_VERSION} (+https://github.com/rianvdm/discogs-mcp)`
const KV_PREFIX = 'username-id:'
const KV_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
// Cap retries on the auth path: a single Discogs blip would otherwise stall
// the OAuth callback ~7s before fail-closing. 1 retry → 2 total attempts.
const RESOLVE_MAX_RETRIES = 1

const hotCache = new Map<string, string>()

/**
 * Parse ALLOWED_DISCOGS_USERNAMES into a list of normalized usernames.
 * Accepts a single name ("jhuggart") or a comma-separated list ("a,b,c").
 * Trims whitespace, lowercases, drops empties. Empty/unset returns [].
 */
export function parseUsernameList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Resolve a list of Discogs usernames to numeric user IDs (as strings).
 *
 * Lookup order per username: module-level Map → KV (`username-id:<name>`) →
 * `GET https://api.discogs.com/users/<name>`. Successful resolutions populate
 * both caches (KV with a 7-day TTL). Failures are logged and silently dropped
 * from the result; failures are NOT cached so a typo can be fixed by editing
 * config without waiting out a stale negative entry.
 *
 * Lookups are issued in parallel via Promise.all.
 */
export async function resolveUsernamesToIds(
  usernames: string[],
  kv: KVNamespace,
): Promise<string[]> {
  if (usernames.length === 0) return []

  const results = await Promise.all(
    usernames.map((name) => resolveOne(name, kv)),
  )

  return results.filter((id): id is string => id !== null)
}

async function resolveOne(username: string, kv: KVNamespace): Promise<string | null> {
  const cached = hotCache.get(username)
  if (cached) return cached

  try {
    const fromKv = await kv.get(`${KV_PREFIX}${username}`)
    if (fromKv) {
      hotCache.set(username, fromKv)
      return fromKv
    }
  } catch (error) {
    console.warn(`[username-resolver] KV read failed for ${username}:`, error)
  }

  try {
    const response = await fetchWithRetry(
      `https://api.discogs.com/users/${encodeURIComponent(username)}`,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      },
      { maxRetries: RESOLVE_MAX_RETRIES },
    )
    const body = (await response.json()) as { id?: number }
    if (typeof body.id !== 'number') {
      console.warn(`[username-resolver] No id in response for ${username}`)
      return null
    }

    const id = String(body.id)
    hotCache.set(username, id)
    try {
      await kv.put(`${KV_PREFIX}${username}`, id, { expirationTtl: KV_TTL_SECONDS })
    } catch (error) {
      console.warn(`[username-resolver] KV write failed for ${username}:`, error)
    }
    return id
  } catch (error) {
    console.warn(`[username-resolver] Failed to resolve ${username}:`, error)
    return null
  }
}

/**
 * Test-only: clear the module-level hot cache between cases.
 */
export function _resetHotCacheForTests(): void {
  hotCache.clear()
}
