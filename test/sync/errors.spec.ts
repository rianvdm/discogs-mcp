// ABOUTME: Tests for the sync error classifier that tells a revoked Discogs token
// ABOUTME: apart from throttling and other failures.
import { describe, it, expect } from 'vitest'
import { isUnauthorizedError } from '../../src/sync/errors'

describe('isUnauthorizedError', () => {
	it('recognises a Discogs 401 as DiscogsClient reports it', () => {
		expect(isUnauthorizedError(new Error('Failed to search collection: HTTP 401: {"message":"You must authenticate"}'))).toBe(true)
	})

	it('recognises a bare Unauthorized message', () => {
		expect(isUnauthorizedError(new Error('Unauthorized'))).toBe(true)
	})

	it('does not mistake a 429 whose body carries the number 401 for a revoked token', () => {
		const tripped = 'Failed to search collection: HTTP 429: {"error":"Discogs rate-limit circuit tripped","retryAfterSecs":401}'
		expect(isUnauthorizedError(new Error(tripped))).toBe(false)
	})

	it('trusts the outer status over an Unauthorized in a 429 body', () => {
		expect(isUnauthorizedError(new Error('Failed to search collection: HTTP 429: {"message":"Unauthorized"}'))).toBe(false)
	})

	it('trusts the outer status over a 401 mentioned in a 502 body', () => {
		expect(isUnauthorizedError(new Error('Failed to search collection: HTTP 502: upstream returned HTTP 401'))).toBe(false)
	})

	it('does not flag a server error', () => {
		expect(isUnauthorizedError(new Error('Failed to search collection: HTTP 500: boom'))).toBe(false)
	})

	it('handles a thrown value that is not an Error', () => {
		expect(isUnauthorizedError('boom')).toBe(false)
	})
})
