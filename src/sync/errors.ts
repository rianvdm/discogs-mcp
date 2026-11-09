// ABOUTME: Classifies sync errors, so a revoked Discogs token is told apart from
// ABOUTME: throttling and other failures that should be retried on the next run.

/**
 * Whether an error means Discogs rejected the stored OAuth token.
 *
 * DiscogsClient reports HTTP failures as `HTTP <status>: <body>`, so the first
 * status in the message is the response's own and decides the answer. The body
 * is never searched when a status is present: a 429 or 502 body can mention
 * "Unauthorized" or carry the number 401 (a circuit breaker's `retryAfterSecs`,
 * say), and reading either as a revoked token would delete a working token
 * mirror. A bare "Unauthorized" counts only for errors with no HTTP status.
 */
export function isUnauthorizedError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	const status = /\bHTTP (\d{3})\b/.exec(message)?.[1]
	if (status !== undefined) return status === '401'
	return /\bUnauthorized\b/i.test(message)
}
