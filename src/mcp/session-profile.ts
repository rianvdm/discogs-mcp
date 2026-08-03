import type { SessionPayload } from './server.js'

/** The authenticated user's Discogs identity, as carried on the session. */
export interface SessionProfile {
	username: string
	numericId: string
}

/**
 * Read the authenticated user's Discogs identity off the session.
 *
 * `/oauth/identity` is fetched exactly once, during the OAuth handshake
 * (`src/auth/oauth-handler.ts`), and both fields are written onto every request
 * context from there (`src/index-oauth.ts` -> `setContext`). Re-fetching them
 * per tool invocation spent rate-limit budget on data we already hold, and a
 * miss on that call's 6h cache was enough to trip the rate limiter's circuit
 * breaker and take the server down for 10 minutes — see issue #45.
 *
 * This is deliberately synchronous: there is no network path here, and keeping
 * it that way makes it obvious at every call site that no budget is at stake.
 */
export function sessionProfile(session: Pick<SessionPayload, 'username' | 'numericId'>): SessionProfile {
	if (!session.username) {
		// Unreachable via either auth path — both gate on a username before
		// calling setContext — but failing loudly beats emitting requests to
		// `/users//collection` and getting mystery 404s back.
		throw new Error('Session is missing a Discogs username; re-authenticate to continue.')
	}
	return { username: session.username, numericId: session.numericId }
}
