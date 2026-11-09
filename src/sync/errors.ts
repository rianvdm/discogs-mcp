// ABOUTME: Classifies sync errors, so a revoked Discogs token is told apart from
// ABOUTME: throttling and other failures that should be retried on the next run.

/**
 * Whether an error means Discogs rejected the stored OAuth token. DiscogsClient
 * reports HTTP failures as `HTTP <status>: <body>`, so the status is matched in
 * that form: a 429 body can carry the number 401 (a circuit breaker's
 * `retryAfterSecs`, say), and reading that as a revoked token would delete a
 * working token mirror.
 */
export function isUnauthorizedError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	return /\bHTTP 401\b/.test(message) || /\bUnauthorized\b/i.test(message)
}
