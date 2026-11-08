// ABOUTME: OAuth 1.0a client for Discogs: signs requests and runs the sign-in handshake (request token, access token, identity).
// ABOUTME: Sends handshake calls through the rate limiter Durable Object when one is set, and straight to Discogs otherwise.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="webworker" />

import { rateLimitedFetch } from '../rate-limiter/client'
import type { RateLimiterStub } from '../rate-limiter/types'
import { fetchWithRetry, RetryOptions } from '../utils/retry'

interface DiscogsTokenResponse {
	oauth_token: string
	oauth_token_secret: string
	oauth_callback_confirmed?: string
}

interface DiscogsAccessTokenResponse {
	oauth_token: string
	oauth_token_secret: string
}

/** The fields of Discogs' `/oauth/identity` response that sign-in uses. */
export interface DiscogsIdentity {
	id: number
	username: string
}

interface HandshakeRequest {
	method: string
	headers: Record<string, string>
	body?: string
}

const RATE_LIMIT_MESSAGE = 'Discogs API rate limit exceeded during authentication. Please try again later.'

// Helper function to convert ArrayBuffer to base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let binary = ''
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary)
}

// Generate a random nonce
function generateNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	let result = ''
	for (let i = 0; i < 32; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length))
	}
	return result
}

// Get current timestamp
function getTimestamp(): string {
	return Math.floor(Date.now() / 1000).toString()
}

// Percent encode according to RFC 3986
function percentEncode(str: string): string {
	return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

export class DiscogsAuth {
	private consumerKey: string
	private consumerSecret: string
	private requestTokenUrl = 'https://api.discogs.com/oauth/request_token'
	private accessTokenUrl = 'https://api.discogs.com/oauth/access_token'
	private identityUrl = 'https://api.discogs.com/oauth/identity'
	private authorizeUrl = 'https://discogs.com/oauth/authorize'
	private userAgent = 'discogs-mcp/1.0.0'
	private lastRequestTime = 0
	private rateLimiterStub: RateLimiterStub | null = null

	// Discogs-specific retry configuration for auth requests (more aggressive than default)
	private readonly discogsRetryOptions: RetryOptions = {
		maxRetries: 3, // Balanced for both production and testing
		initialDelayMs: 1500, // Moderately increased from default 1000ms
		maxDelayMs: 20000, // Reasonable max delay (20s)
		backoffMultiplier: 2,
		jitterFactor: 0.1,
	}

	// Minimum delay between auth requests (proactive rate limiting)
	private readonly REQUEST_DELAY_MS = 200 // 200ms for auth requests (slightly more conservative)

	/**
	 * Add a small delay between requests to proactively avoid rate limits
	 */
	private async throttleRequest(): Promise<void> {
		const timeSinceLastRequest = Date.now() - this.lastRequestTime
		if (timeSinceLastRequest < this.REQUEST_DELAY_MS) {
			const delayNeeded = this.REQUEST_DELAY_MS - timeSinceLastRequest
			await new Promise((resolve) => setTimeout(resolve, delayNeeded))
		}
		this.lastRequestTime = Date.now()
	}

	constructor(consumerKey: string, consumerSecret: string) {
		this.consumerKey = consumerKey
		this.consumerSecret = consumerSecret
	}

	/**
	 * Route the handshake calls through the rate limiter, on its interactive
	 * lane: someone is waiting in a browser for each of them.
	 */
	setRateLimiter(stub: RateLimiterStub): void {
		this.rateLimiterStub = stub
	}

	/**
	 * Send one handshake call to Discogs and return the successful response,
	 * or throw `HTTP <status>: <body>` for any other.
	 *
	 * Through the rate limiter the call is sent once. The limiter already paces
	 * it against the shared budget and retries a 429 within the interactive
	 * lane's backoff, so retrying here would spend budget behind its back.
	 * Without the limiter, the call goes straight to Discogs with a short pause
	 * between calls and retries of its own.
	 */
	private async handshakeFetch(url: string, request: HandshakeRequest): Promise<Response> {
		if (!this.rateLimiterStub) {
			await this.throttleRequest()
			return fetchWithRetry(url, request, this.discogsRetryOptions)
		}

		const response = await rateLimitedFetch(this.rateLimiterStub, url, request)
		if (!response.ok) {
			const body = await response.text()
			throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`)
		}
		return response
	}

	/**
	 * Compute HMAC-SHA1 signature using Web Crypto API
	 */
	private async computeSignature(baseString: string, key: string): Promise<string> {
		const encoder = new TextEncoder()
		const keyData = encoder.encode(key)
		const messageData = encoder.encode(baseString)

		const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])

		const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)
		return arrayBufferToBase64(signature)
	}

	/**
	 * Create OAuth signature base string per RFC 5849 §3.4.1.
	 * The base string URI excludes any query string; query parameters are
	 * extracted and merged with the supplied parameters before sorting.
	 */
	private createSignatureBaseString(method: string, url: string, parameters: Record<string, string>): string {
		const parsed = new URL(url)
		const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`

		const allParams: Array<[string, string]> = []
		for (const [key, value] of parsed.searchParams) {
			allParams.push([percentEncode(key), percentEncode(value)])
		}
		for (const [key, value] of Object.entries(parameters)) {
			allParams.push([percentEncode(key), percentEncode(value)])
		}

		const sortedParams = allParams
			.sort(([k1, v1], [k2, v2]) => {
				if (k1 < k2) return -1
				if (k1 > k2) return 1
				if (v1 < v2) return -1
				if (v1 > v2) return 1
				return 0
			})
			.map(([k, v]) => `${k}=${v}`)
			.join('&')

		return `${method}&${percentEncode(baseUrl)}&${percentEncode(sortedParams)}`
	}

	/**
	 * Create OAuth signing key
	 */
	private createSigningKey(tokenSecret?: string): string {
		return `${percentEncode(this.consumerSecret)}&${percentEncode(tokenSecret || '')}`
	}

	/**
	 * Generate OAuth authorization header
	 */
	private async generateOAuthHeader(
		method: string,
		url: string,
		additionalParams: Record<string, string> = {},
		token?: { key: string; secret: string },
	): Promise<string> {
		const oauthParams: Record<string, string> = {
			oauth_consumer_key: this.consumerKey,
			oauth_nonce: generateNonce(),
			oauth_signature_method: 'HMAC-SHA1',
			oauth_timestamp: getTimestamp(),
			oauth_version: '1.0',
			...additionalParams,
		}

		if (token) {
			oauthParams.oauth_token = token.key
		}

		// Create signature base string
		const allParams = { ...oauthParams }
		const baseString = this.createSignatureBaseString(method, url, allParams)

		// Create signing key
		const signingKey = this.createSigningKey(token?.secret)

		// Generate signature
		const signature = await this.computeSignature(baseString, signingKey)
		oauthParams.oauth_signature = signature

		// Create authorization header
		const authParams = Object.keys(oauthParams)
			.map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
			.join(', ')

		return `OAuth ${authParams}`
	}

	/**
	 * Get a request token from Discogs
	 * @param callbackUrl The URL to redirect to after authorization
	 * @returns Request token and secret
	 */
	async getRequestToken(callbackUrl: string): Promise<DiscogsTokenResponse> {
		console.log('Getting OAuth header for request token...')

		const authHeader = await this.generateOAuthHeader('GET', this.requestTokenUrl, { oauth_callback: callbackUrl })

		console.log('Making request to:', this.requestTokenUrl)

		try {
			const response = await this.handshakeFetch(this.requestTokenUrl, {
				method: 'GET',
				headers: {
					Authorization: authHeader,
					'User-Agent': this.userAgent,
				},
			})

			const text = await response.text()

			const params = new URLSearchParams(text)

			const oauthToken = params.get('oauth_token')
			const oauthTokenSecret = params.get('oauth_token_secret')
			const oauthCallbackConfirmed = params.get('oauth_callback_confirmed')

			if (!oauthToken || !oauthTokenSecret) {
				throw new Error('Invalid response from Discogs: missing oauth_token or oauth_token_secret')
			}

			return {
				oauth_token: oauthToken,
				oauth_token_secret: oauthTokenSecret,
				oauth_callback_confirmed: oauthCallbackConfirmed || undefined,
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes('429')) {
				throw new Error(RATE_LIMIT_MESSAGE)
			}
			console.error('Discogs API error:', error)
			throw new Error(`Failed to get request token: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	/**
	 * Get the authorization URL for the user to visit
	 * @param oauthToken The request token
	 * @returns The authorization URL
	 */
	getAuthorizeUrl(oauthToken: string): string {
		return `${this.authorizeUrl}?oauth_token=${oauthToken}`
	}

	/**
	 * Exchange request token and verifier for access token
	 * @param oauthToken The request token
	 * @param oauthTokenSecret The request token secret
	 * @param oauthVerifier The verification code from the callback
	 * @returns Access token and secret
	 */
	async getAccessToken(oauthToken: string, oauthTokenSecret: string, oauthVerifier: string): Promise<DiscogsAccessTokenResponse> {
		const token = {
			key: oauthToken,
			secret: oauthTokenSecret,
		}

		const authHeader = await this.generateOAuthHeader('POST', this.accessTokenUrl, { oauth_verifier: oauthVerifier }, token)

		try {
			const response = await this.handshakeFetch(this.accessTokenUrl, {
				method: 'POST',
				headers: {
					Authorization: authHeader,
					'Content-Type': 'application/x-www-form-urlencoded',
					'User-Agent': this.userAgent,
				},
				body: `oauth_verifier=${encodeURIComponent(oauthVerifier)}`,
			})

			const text = await response.text()
			const params = new URLSearchParams(text)

			const accessToken = params.get('oauth_token')
			const accessTokenSecret = params.get('oauth_token_secret')

			if (!accessToken || !accessTokenSecret) {
				throw new Error('Invalid response from Discogs: missing oauth_token or oauth_token_secret')
			}

			return {
				oauth_token: accessToken,
				oauth_token_secret: accessTokenSecret,
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes('429')) {
				throw new Error(RATE_LIMIT_MESSAGE)
			}
			console.error('Discogs API error:', error)
			throw new Error(`Failed to get access token: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	/**
	 * Fetch the Discogs user an access token belongs to
	 * @param accessToken The access token from getAccessToken
	 * @param accessTokenSecret The access token secret from getAccessToken
	 * @returns The user's numeric ID and username
	 */
	async getIdentity(accessToken: string, accessTokenSecret: string): Promise<DiscogsIdentity> {
		const authHeader = await this.generateOAuthHeader('GET', this.identityUrl, {}, { key: accessToken, secret: accessTokenSecret })

		try {
			const response = await this.handshakeFetch(this.identityUrl, {
				method: 'GET',
				headers: {
					Authorization: authHeader,
					'User-Agent': this.userAgent,
				},
			})
			return (await response.json()) as DiscogsIdentity
		} catch (error) {
			if (error instanceof Error && error.message.includes('429')) {
				throw new Error(RATE_LIMIT_MESSAGE)
			}
			throw new Error(`Failed to fetch Discogs identity: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	/**
	 * Create OAuth headers for authenticated requests
	 * @param url The request URL
	 * @param method The HTTP method
	 * @param token The access token
	 * @returns OAuth headers
	 */
	async getAuthHeaders(url: string, method: string, token: { key: string; secret: string }): Promise<Record<string, string>> {
		const authHeader = await this.generateOAuthHeader(method, url, {}, token)

		return {
			Authorization: authHeader,
		}
	}
}
