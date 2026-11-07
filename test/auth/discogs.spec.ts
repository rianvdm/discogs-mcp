// ABOUTME: Unit tests for DiscogsAuth, the OAuth 1.0a handshake client for Discogs.
// ABOUTME: Covers signing, token parsing and errors, both calling Discogs directly and through the rate limiter Durable Object.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { DiscogsAuth } from '../../src/auth/discogs'
import type { RateLimiterRequest, RateLimiterResponse, RateLimiterStub } from '../../src/rate-limiter/types'

// Mock fetch globally
const mockFetch = vi.fn()
;(globalThis as any).fetch = mockFetch

describe('DiscogsAuth', () => {
	let auth: DiscogsAuth
	const consumerKey = 'test-consumer-key'
	const consumerSecret = 'test-consumer-secret'

	beforeEach(() => {
		auth = new DiscogsAuth(consumerKey, consumerSecret)
		vi.clearAllMocks()
		// Drop queued responses too, so one test's unused response can't answer the next test's call
		mockFetch.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('getRequestToken', () => {
		it('should successfully get a request token', async () => {
			const mockResponse = 'oauth_token=test-token&oauth_token_secret=test-secret&oauth_callback_confirmed=true'

			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: 'OK',
				text: () => Promise.resolve(mockResponse),
			})

			const result = await auth.getRequestToken('http://localhost:3000/callback')

			expect(result).toEqual({
				oauth_token: 'test-token',
				oauth_token_secret: 'test-secret',
				oauth_callback_confirmed: 'true',
			})

			expect(mockFetch).toHaveBeenCalledWith(
				'https://api.discogs.com/oauth/request_token',
				expect.objectContaining({
					method: 'GET',
					headers: expect.objectContaining({
						Authorization: expect.stringContaining('OAuth'),
						'User-Agent': 'discogs-mcp/1.0.0',
					}),
				}),
			)
		})

		it('should handle API errors', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: 'Unauthorized',
				text: () => Promise.resolve('Invalid consumer key'),
			})

			await expect(auth.getRequestToken('http://localhost:3000/callback')).rejects.toThrow(
				'Failed to get request token: HTTP 401: Unauthorized',
			)
		})

		it('should handle malformed responses', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: 'OK',
				text: () => Promise.resolve('invalid_response'),
			})

			await expect(auth.getRequestToken('http://localhost:3000/callback')).rejects.toThrow(
				'Invalid response from Discogs: missing oauth_token or oauth_token_secret',
			)
		})
	})

	describe('getAuthorizeUrl', () => {
		it('should generate correct authorize URL', () => {
			const oauthToken = 'test-token'
			const url = auth.getAuthorizeUrl(oauthToken)

			expect(url).toBe('https://discogs.com/oauth/authorize?oauth_token=test-token')
		})
	})

	describe('getAccessToken', () => {
		it('should successfully exchange for access token', async () => {
			const mockResponse = 'oauth_token=access-token&oauth_token_secret=access-secret'

			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: 'OK',
				text: () => Promise.resolve(mockResponse),
			})

			const result = await auth.getAccessToken('request-token', 'request-secret', 'verifier')

			expect(result).toEqual({
				oauth_token: 'access-token',
				oauth_token_secret: 'access-secret',
			})

			expect(mockFetch).toHaveBeenCalledWith(
				'https://api.discogs.com/oauth/access_token',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: expect.stringContaining('OAuth'),
						'User-Agent': 'discogs-mcp/1.0.0',
					}),
				}),
			)
		})

		it('should handle access token errors', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: 'Unauthorized',
				text: () => Promise.resolve('Invalid verifier'),
			})

			await expect(auth.getAccessToken('request-token', 'request-secret', 'invalid-verifier')).rejects.toThrow(
				'Failed to get access token: HTTP 401: Unauthorized',
			)
		})

		it('should handle malformed access token responses', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: 'OK',
				text: () => Promise.resolve('invalid_response'),
			})

			await expect(auth.getAccessToken('request-token', 'request-secret', 'verifier')).rejects.toThrow(
				'Invalid response from Discogs: missing oauth_token or oauth_token_secret',
			)
		})
	})

	describe('getAuthHeaders', () => {
		it('should generate correct auth headers for API requests', async () => {
			const token = { key: 'access-token', secret: 'access-secret' }
			const headers = await auth.getAuthHeaders('https://api.discogs.com/users/test', 'GET', token)

			expect(headers).toHaveProperty('Authorization')
			expect(headers.Authorization).toContain('OAuth')
			expect(headers.Authorization).toContain('oauth_consumer_key')
			expect(headers.Authorization).toContain('oauth_token')
			expect(headers.Authorization).toContain('oauth_signature')
			// Note: User-Agent is not included in getAuthHeaders, it's added separately when making requests
		})
	})

	describe('getIdentity', () => {
		it('fetches /oauth/identity signed with the access token', async () => {
			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: 4242, username: 'identityuser' }), { status: 200 }))

			const identity = await auth.getIdentity('access-token', 'access-secret')

			expect(identity).toEqual({ id: 4242, username: 'identityuser' })
			expect(mockFetch).toHaveBeenCalledOnce()
			const [url, init] = mockFetch.mock.calls[0]
			expect(url).toBe('https://api.discogs.com/oauth/identity')
			expect(init.method).toBe('GET')
			expect(init.headers.Authorization).toContain('oauth_token="access-token"')
			expect(init.headers['User-Agent']).toBe('discogs-mcp/1.0.0')
		})

		it('reports the status when Discogs refuses the identity call', async () => {
			mockFetch.mockResolvedValueOnce(new Response('Invalid token', { status: 401 }))

			await expect(auth.getIdentity('access-token', 'access-secret')).rejects.toThrow('Failed to fetch Discogs identity: HTTP 401')
		})
	})

	describe('calling Discogs directly (no rate limiter)', () => {
		afterEach(() => {
			vi.useRealTimers()
		})

		it('retries a 429 itself, then reports the rate limit', async () => {
			vi.useFakeTimers()
			mockFetch.mockImplementation(async () => new Response('Too many requests', { status: 429 }))

			const result = auth.getRequestToken('http://localhost/callback')
			const assertion = expect(result).rejects.toThrow('Discogs API rate limit exceeded during authentication. Please try again later.')
			await vi.runAllTimersAsync()
			await assertion

			// One call plus three retries (discogsRetryOptions.maxRetries)
			expect(mockFetch).toHaveBeenCalledTimes(4)
		})
	})

	describe('through the rate limiter', () => {
		const REQUEST_TOKEN_BODY = 'oauth_token=rl-token&oauth_token_secret=rl-secret&oauth_callback_confirmed=true'
		const ACCESS_TOKEN_BODY = 'oauth_token=rl-access&oauth_token_secret=rl-access-secret'

		/** A rate limiter stub that answers each call with the next canned Discogs response. */
		function createStub(...responses: RateLimiterResponse[]): RateLimiterStub & { fetch: ReturnType<typeof vi.fn> } {
			const fetch = vi.fn()
			for (const response of responses) {
				fetch.mockResolvedValueOnce(
					new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } }),
				)
			}
			return { fetch }
		}

		/** The requests the stub was asked to send to Discogs, in order. */
		async function sentRequests(stub: { fetch: ReturnType<typeof vi.fn> }): Promise<RateLimiterRequest[]> {
			return Promise.all(stub.fetch.mock.calls.map(([request]) => (request as Request).json() as Promise<RateLimiterRequest>))
		}

		/** Pin the nonce and timestamp so two calls sign identically. */
		function pinSignatureInputs(): void {
			vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-07T00:00:00Z').getTime())
			vi.spyOn(Math, 'random').mockReturnValue(0.5)
		}

		it('sends request_token through the stub with the same signed header as a direct call', async () => {
			pinSignatureInputs()
			mockFetch.mockResolvedValueOnce(new Response(REQUEST_TOKEN_BODY, { status: 200 }))
			await new DiscogsAuth(consumerKey, consumerSecret).getRequestToken('https://example.com/discogs-callback')
			const directHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>
			mockFetch.mockClear()

			const stub = createStub({ status: 200, headers: {}, body: REQUEST_TOKEN_BODY })
			auth.setRateLimiter(stub)
			const result = await auth.getRequestToken('https://example.com/discogs-callback')

			expect(result).toEqual({ oauth_token: 'rl-token', oauth_token_secret: 'rl-secret', oauth_callback_confirmed: 'true' })
			expect(mockFetch).not.toHaveBeenCalled()
			const [sent] = await sentRequests(stub)
			expect(sent.url).toBe('https://api.discogs.com/oauth/request_token')
			expect(sent.method).toBe('GET')
			expect(sent.headers.Authorization).toBe(directHeaders.Authorization)
			expect(sent.headers.Authorization).toContain('oauth_callback=')
			expect(sent.headers['User-Agent']).toBe('discogs-mcp/1.0.0')
			expect(sent.body).toBeUndefined()
			// Interactive lane: someone is waiting in a browser
			expect(sent.priority).toBeUndefined()
		})

		it('sends access_token through the stub as a POST with the verifier in the form body', async () => {
			pinSignatureInputs()
			mockFetch.mockResolvedValueOnce(new Response(ACCESS_TOKEN_BODY, { status: 200 }))
			await new DiscogsAuth(consumerKey, consumerSecret).getAccessToken('request-token', 'request-secret', 'the verifier')
			const directHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>
			mockFetch.mockClear()

			const stub = createStub({ status: 200, headers: {}, body: ACCESS_TOKEN_BODY })
			auth.setRateLimiter(stub)
			const result = await auth.getAccessToken('request-token', 'request-secret', 'the verifier')

			expect(result).toEqual({ oauth_token: 'rl-access', oauth_token_secret: 'rl-access-secret' })
			expect(mockFetch).not.toHaveBeenCalled()
			const [sent] = await sentRequests(stub)
			expect(sent.url).toBe('https://api.discogs.com/oauth/access_token')
			expect(sent.method).toBe('POST')
			expect(sent.headers.Authorization).toBe(directHeaders.Authorization)
			expect(sent.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
			expect(sent.headers['User-Agent']).toBe('discogs-mcp/1.0.0')
			expect(sent.body).toBe('oauth_verifier=the%20verifier')
			expect(sent.priority).toBeUndefined()
		})

		it('sends /oauth/identity through the stub', async () => {
			const stub = createStub({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":4242,"username":"rluser"}' })
			auth.setRateLimiter(stub)

			const identity = await auth.getIdentity('access-token', 'access-secret')

			expect(identity).toEqual({ id: 4242, username: 'rluser' })
			expect(mockFetch).not.toHaveBeenCalled()
			const [sent] = await sentRequests(stub)
			expect(sent.url).toBe('https://api.discogs.com/oauth/identity')
			expect(sent.method).toBe('GET')
			expect(sent.headers.Authorization).toContain('oauth_token="access-token"')
			expect(sent.headers['User-Agent']).toBe('discogs-mcp/1.0.0')
			expect(sent.priority).toBeUndefined()
		})

		it.each([
			['getRequestToken', (a: DiscogsAuth) => a.getRequestToken('https://example.com/discogs-callback')],
			['getAccessToken', (a: DiscogsAuth) => a.getAccessToken('request-token', 'request-secret', 'verifier')],
			['getIdentity', (a: DiscogsAuth) => a.getIdentity('access-token', 'access-secret')],
		])('%s reports a 429 from the limiter as the rate limit without retrying it', async (_name, call) => {
			const stub = createStub({ status: 429, headers: { 'retry-after': '60' }, body: '{"error":"Discogs rate-limit circuit tripped"}' })
			auth.setRateLimiter(stub)

			await expect(call(auth)).rejects.toThrow('Discogs API rate limit exceeded during authentication. Please try again later.')

			// The limiter already retried within its lane; a second layer would spend budget behind its back.
			expect(stub.fetch).toHaveBeenCalledOnce()
			expect(mockFetch).not.toHaveBeenCalled()
		})

		it.each([
			[
				'getRequestToken',
				(a: DiscogsAuth) => a.getRequestToken('https://example.com/discogs-callback'),
				'Failed to get request token: HTTP 401',
			],
			[
				'getAccessToken',
				(a: DiscogsAuth) => a.getAccessToken('request-token', 'request-secret', 'verifier'),
				'Failed to get access token: HTTP 401',
			],
			['getIdentity', (a: DiscogsAuth) => a.getIdentity('access-token', 'access-secret'), 'Failed to fetch Discogs identity: HTTP 401'],
		])('%s reports any other refusal with its status, once', async (_name, call, message) => {
			const stub = createStub({ status: 401, headers: { 'x-discogs-media-type': 'discogs.v2' }, body: 'Invalid consumer.' })
			auth.setRateLimiter(stub)

			await expect(call(auth)).rejects.toThrow(message)
			expect(stub.fetch).toHaveBeenCalledOnce()
		})

		it('rejects a malformed token response from the limiter', async () => {
			auth.setRateLimiter(createStub({ status: 200, headers: {}, body: 'invalid_response' }))

			await expect(auth.getRequestToken('https://example.com/discogs-callback')).rejects.toThrow(
				'Invalid response from Discogs: missing oauth_token or oauth_token_secret',
			)
		})
	})

	describe('security', () => {
		it('should not log the signed Authorization header', async () => {
			const consoleSpy = vi.spyOn(console, 'log')
			mockFetch.mockResolvedValueOnce(new Response('oauth_token=tok&oauth_token_secret=sec', { status: 200 }))

			await auth.getRequestToken('http://localhost/callback')

			const loggedMessages = consoleSpy.mock.calls.map((args) => args.join(' '))
			expect(loggedMessages.some((msg) => msg.includes('oauth_signature'))).toBe(false)
		})

		it('should not log the request token secret from the Discogs response', async () => {
			const consoleSpy = vi.spyOn(console, 'log')
			mockFetch.mockResolvedValueOnce(new Response('oauth_token=tok&oauth_token_secret=the-request-secret', { status: 200 }))

			await auth.getRequestToken('http://localhost/callback')

			const loggedMessages = consoleSpy.mock.calls.map((args) => args.join(' '))
			expect(loggedMessages.some((msg) => msg.includes('the-request-secret'))).toBe(false)
		})

		it('should not log the signing key or signature', async () => {
			const consoleSpy = vi.spyOn(console, 'log')
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: 'OK',
				text: () => Promise.resolve('oauth_token=tok&oauth_token_secret=sec'),
			})
			await auth.getRequestToken('http://localhost/callback')
			const loggedMessages = consoleSpy.mock.calls.map((args) => args.join(' '))
			expect(loggedMessages.some((msg) => msg.includes('signing key'))).toBe(false)
			expect(loggedMessages.some((msg) => msg.includes('OAuth signature:'))).toBe(false)
		})
	})

	describe('OAuth signature generation', () => {
		it('should generate consistent signatures for the same parameters', async () => {
			// Mock Date.now to return consistent timestamp
			const mockDate = new Date('2023-01-01T00:00:00Z')
			vi.spyOn(Date, 'now').mockReturnValue(mockDate.getTime())

			// Mock Math.random to return consistent nonce
			vi.spyOn(Math, 'random').mockReturnValue(0.5)

			const token = { key: 'test-token', secret: 'test-secret' }
			const headers1 = await auth.getAuthHeaders('https://api.discogs.com/test', 'GET', token)
			const headers2 = await auth.getAuthHeaders('https://api.discogs.com/test', 'GET', token)

			expect(headers1.Authorization).toBe(headers2.Authorization)
		})

		it('should include URL query parameters in the signature base string', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(new Date('2023-01-01T00:00:00Z').getTime())
			vi.spyOn(Math, 'random').mockReturnValue(0.5)

			const token = { key: 'test-token', secret: 'test-secret' }
			const extractSig = (auth: string) => /oauth_signature="([^"]+)"/.exec(auth)?.[1]

			const withQuery = await auth.getAuthHeaders(
				'https://api.discogs.com/users/x/collection/folders/0/releases?page=1&per_page=100',
				'GET',
				token,
			)
			const withoutQuery = await auth.getAuthHeaders('https://api.discogs.com/users/x/collection/folders/0/releases', 'GET', token)
			const reorderedQuery = await auth.getAuthHeaders(
				'https://api.discogs.com/users/x/collection/folders/0/releases?per_page=100&page=1',
				'GET',
				token,
			)

			// Query parameters must affect the signature (otherwise Discogs rejects the request).
			expect(extractSig(withQuery.Authorization)).not.toBe(extractSig(withoutQuery.Authorization))
			// Query parameter order must not matter (signing sorts them).
			expect(extractSig(withQuery.Authorization)).toBe(extractSig(reorderedQuery.Authorization))
		})
	})
})
