/**
 * Discogs MCP Server - Cloudflare Worker
 * Implements Model Context Protocol for Discogs collection access
 * Now using Cloudflare Agents SDK + @modelcontextprotocol/sdk
 */

import { createMcpHandler } from "agents/mcp";
import { createServer } from "./mcp/server.js";
import { DiscogsAuth } from './auth/discogs'
import { createSessionToken, verifySessionToken } from './auth/jwt'
import type { Env } from './types/env'
import type { ExecutionContext } from '@cloudflare/workers-types'

// These types are available globally in Workers runtime
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="webworker" />

/**
 * Helper function to add CORS headers to responses
 */
function addCorsHeaders(headers: HeadersInit = {}): Headers {
	const corsHeaders = new Headers(headers)
	corsHeaders.set('Access-Control-Allow-Origin', '*')
	corsHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
	corsHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Connection-ID, Mcp-Session-Id, Cookie')
	return corsHeaders
}

/**
 * Handle MCP request with session ID generation and response header injection
 */
async function handleMCPRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url)

	// Get session ID from multiple sources (in priority order):
	// 1. URL query param (for clients that can't persist headers)
	// 2. Mcp-Session-Id header (MCP standard)
	// 3. X-Connection-ID header (legacy)
	// 4. Generate deterministic ID based on client characteristics
	const urlSessionId = url.searchParams.get('session_id')
	const headerSessionId = request.headers.get('Mcp-Session-Id')
	const connectionId = request.headers.get('X-Connection-ID')

	let sessionId = urlSessionId || headerSessionId || connectionId
	let sessionSource = urlSessionId ? 'url' : headerSessionId ? 'header' : connectionId ? 'x-connection' : 'generated'

	if (!sessionId) {
		// Generate a DETERMINISTIC session ID based on client characteristics
		// This ensures the same client gets the same session ID even after reconnecting
		// (mcp-remote doesn't persist session headers between reconnects)
		const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
		const userAgent = request.headers.get('User-Agent') || 'unknown'
		// Use weekly timestamp to ensure session ID is stable for 7 days (matches session expiry)
		const weekTimestamp = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7))

		// Create a hash-based session ID that's consistent for the same client/week
		const encoder = new TextEncoder()
		const data = encoder.encode(`${clientIP}-${userAgent}-${weekTimestamp}`)
		const hashBuffer = await crypto.subtle.digest('SHA-256', data)
		const hashArray = new Uint8Array(hashBuffer)
		const hashHex = Array.from(hashArray)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')

		sessionId = `mcp-${hashHex.substring(0, 32)}`
		sessionSource = 'deterministic'
	}

	console.log(`[MCP] Session ID: ${sessionId} (source: ${sessionSource})`)

	// Create MCP server instance with session ID
	const server = createServer(env, request, sessionId)
	const handler = createMcpHandler(server)

	// Call the handler
	const response = await handler(request, env, ctx)

	// Clone the response to add our session ID header
	// This ensures clients can persist the session ID for subsequent requests
	const newHeaders = new Headers(response.headers)
	newHeaders.set('Mcp-Session-Id', sessionId)
	newHeaders.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	})
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url)

		// Handle CORS preflight requests
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 200,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Connection-ID, Mcp-Session-Id, Cookie',
					'Access-Control-Expose-Headers': 'Mcp-Session-Id',
					'Access-Control-Max-Age': '86400',
				},
			})
		}

		// Handle different endpoints
		switch (url.pathname) {
			case '/':
				// Main endpoint - POST routes to MCP, GET shows info
				if (request.method === 'POST') {
					// Backward compatibility: POST / routes to MCP handler
					return handleMCPRequest(request, env, ctx);
				} else if (request.method === 'GET') {
					return new Response(
						JSON.stringify({
							name: 'Discogs MCP Server',
							version: '1.0.0',
							description: 'Model Context Protocol server for Discogs collection access (SDK-based)',
							endpoints: {
								'/': 'POST - MCP JSON-RPC endpoint (backward compat)',
								'/mcp': 'POST - Primary MCP endpoint',
								'/login': 'GET - OAuth login',
								'/callback': 'GET - OAuth callback',
								'/mcp-auth': 'GET - MCP authentication',
								'/health': 'GET - Health check',
							},
						}),
						{
							status: 200,
							headers: {
								'Content-Type': 'application/json',
								'Access-Control-Allow-Origin': '*',
							},
						},
					)
				} else {
					return new Response('Method not allowed', { status: 405 })
				}

			case '/mcp':
				// Primary MCP endpoint
				if (request.method === 'POST' || request.method === 'GET') {
					return handleMCPRequest(request, env, ctx);
				} else {
					return new Response('Method not allowed. Use POST or GET for MCP requests.', { status: 405 })
				}

			case '/login':
				// OAuth login - redirect to Discogs
				if (request.method !== 'GET') {
					return new Response('Method not allowed', { status: 405 })
				}
				return handleLogin(request, env)

			case '/callback':
				// OAuth callback - exchange tokens
				if (request.method !== 'GET') {
					return new Response('Method not allowed', { status: 405 })
				}
				return handleCallback(request, env)

			case '/mcp-auth':
				// MCP authentication endpoint for programmatic access
				if (request.method !== 'GET') {
					return new Response('Method not allowed', { status: 405 })
				}
				return handleMCPAuth(request, env)

			case '/health':
				// Health check endpoint
				return new Response(
					JSON.stringify({
						status: 'ok',
						timestamp: new Date().toISOString(),
						version: '1.0.0',
						service: 'discogs-mcp',
					}),
					{
						status: 200,
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*',
						},
					},
				)

			default:
				return new Response('Not found', { status: 404 })
		}
	},
}

/**
 * Handle OAuth login request
 */
async function handleLogin(request: Request, env: Env): Promise<Response> {
	try {
		// Debug: Log environment variables (without secrets)
		console.log('Environment check:', {
			hasConsumerKey: !!env.DISCOGS_CONSUMER_KEY,
			hasConsumerSecret: !!env.DISCOGS_CONSUMER_SECRET,
			consumerKeyLength: env.DISCOGS_CONSUMER_KEY?.length || 0,
			consumerSecretLength: env.DISCOGS_CONSUMER_SECRET?.length || 0,
		})

		if (!env.DISCOGS_CONSUMER_KEY || !env.DISCOGS_CONSUMER_SECRET) {
			console.error('Missing Discogs OAuth credentials')
			return new Response('OAuth configuration error: Missing credentials', { status: 500 })
		}

		const auth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)

		// Get callback URL based on the current request URL
		const url = new URL(request.url)
		const connectionId = url.searchParams.get('connection_id')
		const callbackUrl = `${url.protocol}//${url.host}/callback${connectionId ? `?connection_id=${connectionId}` : ''}`

		console.log('Requesting OAuth token from Discogs...', { connectionId })

		// Get request token
		const { oauth_token, oauth_token_secret } = await auth.getRequestToken(callbackUrl)

		console.log('Successfully received OAuth token:', {
			tokenLength: oauth_token.length,
			secretLength: oauth_token_secret.length,
		})

		// Store token secret temporarily with connection ID
		await env.MCP_SESSIONS.put(`oauth-token:${oauth_token}`, JSON.stringify({
			tokenSecret: oauth_token_secret,
			connectionId: connectionId || 'unknown'
		}), {
			expirationTtl: 600, // 10 minutes - OAuth flow should complete within this time
		})

		// Redirect to Discogs authorization page
		const authorizeUrl = auth.getAuthorizeUrl(oauth_token)
		console.log('Redirecting to:', authorizeUrl)

		return Response.redirect(authorizeUrl, 302)
	} catch (error) {
		console.error('OAuth login error:', error)

		// Provide more detailed error information
		let errorMessage = 'OAuth login failed'
		if (error instanceof Error) {
			errorMessage += `: ${error.message}`
		}

		return new Response(errorMessage, { status: 500 })
	}
}

/**
 * Handle OAuth callback
 */
async function handleCallback(request: Request, env: Env): Promise<Response> {
	try {
		const url = new URL(request.url)
		const oauthToken = url.searchParams.get('oauth_token')
		const oauthVerifier = url.searchParams.get('oauth_verifier')
		const connectionId = url.searchParams.get('connection_id')

		if (!oauthToken || !oauthVerifier) {
			return new Response('Missing OAuth parameters', { status: 400 })
		}

		// Retrieve token secret and connection ID
		const tokenDataStr = await env.MCP_SESSIONS.get(`oauth-token:${oauthToken}`)
		if (!tokenDataStr) {
			return new Response('Invalid OAuth token', { status: 400 })
		}

		const tokenData = JSON.parse(tokenDataStr)
		const { tokenSecret: oauthTokenSecret, connectionId: storedConnectionId } = tokenData

		// Clean up temporary storage
		// Note: KV delete method exists but TypeScript definitions might be outdated
		// Using TTL on the put operation instead for automatic cleanup
		// await env.MCP_SESSIONS.delete(`oauth-token:${oauthToken}`)

		// Use connection ID from callback URL or stored connection ID
		const finalConnectionId = connectionId || storedConnectionId

		// Exchange for access token
		const auth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
		const { oauth_token: accessToken, oauth_token_secret: accessTokenSecret } = await auth.getAccessToken(
			oauthToken,
			oauthTokenSecret,
			oauthVerifier,
		)

		// Create JWT session token
		const sessionToken = await createSessionToken(
			{
				userId: accessToken, // Use access token as user ID for now
				accessToken,
				accessTokenSecret,
			},
			env.JWT_SECRET,
			168, // expires in 7 days
		)

		// Store session in KV with connection-specific key
		if (env.MCP_SESSIONS && finalConnectionId !== 'unknown') {
			try {
				const sessionData = {
					token: sessionToken,
					userId: accessToken,
					accessToken,
					accessTokenSecret,
					timestamp: Date.now(),
					expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
					connectionId: finalConnectionId,
				}
				// Store with connection-specific key
				await env.MCP_SESSIONS.put(`session:${finalConnectionId}`, JSON.stringify(sessionData), {
					expirationTtl: 7 * 24 * 60 * 60, // 7 days
				})

				console.log(`Session stored for connection ${finalConnectionId}`)
			} catch (error) {
				console.warn('Could not save session to KV:', error)
			}
		}

		// Set secure HTTP-only cookie
		// Using SameSite=Lax to allow navigation-based requests while preventing CSRF
		const cookieOptions = [
			'HttpOnly',
			'Secure',
			'SameSite=Lax', // Changed from Strict to Lax for better compatibility
			'Path=/',
			'Max-Age=604800', // 7 days in seconds
		].join('; ')

		const responseMessage = finalConnectionId !== 'unknown'
			? `Authentication successful! Your MCP connection is now authenticated and ready to use.`
			: `Authentication successful! You can now use the MCP server to access your Discogs collection.`

		return new Response(responseMessage, {
			status: 200,
			headers: {
				'Content-Type': 'text/plain',
				'Set-Cookie': `session=${sessionToken}; ${cookieOptions}`,
			},
		})
	} catch (error) {
		console.error('OAuth callback error:', error)
		return new Response('OAuth callback failed', { status: 500 })
	}
}


/**
 * Handle MCP authentication endpoint - returns latest session token
 */
async function handleMCPAuth(request: Request, env: Env): Promise<Response> {
	try {
		// Try to get the latest session from KV storage
		if (env.MCP_SESSIONS) {
			const sessionDataStr = await env.MCP_SESSIONS.get('latest-session')
			if (sessionDataStr) {
				const sessionData = JSON.parse(sessionDataStr)

				// Return the session token (KV TTL handles expiration)
				return new Response(
					JSON.stringify({
						session_token: sessionData.token,
						user_id: sessionData.userId,
						message: 'Use this token in the Cookie header as: session=' + sessionData.token,
						expires_at: new Date(sessionData.expiresAt).toISOString(),
					}),
					{
						headers: addCorsHeaders({ 'Content-Type': 'application/json' }),
					},
				)
			}
		}

		// Fallback: check if user has a valid session cookie
		try {
			const cookieHeader = request.headers.get('Cookie')
			if (cookieHeader) {
				const cookies = cookieHeader.split(';').reduce(
					(acc, cookie) => {
						const [key, value] = cookie.trim().split('=')
						if (key && value) {
							acc[key] = value
						}
						return acc
					},
					{} as Record<string, string>,
				)

				const sessionToken = cookies.session
				if (sessionToken) {
					const session = await verifySessionToken(sessionToken, env.JWT_SECRET)
					if (session) {
						return new Response(
							JSON.stringify({
								session_token: sessionToken,
								user_id: session.userId,
								message: 'Use this token in the Cookie header as: session=' + sessionToken,
							}),
							{
								headers: addCorsHeaders({ 'Content-Type': 'application/json' }),
							},
						)
					}
				}
			}
		} catch (error) {
			console.error('Session verification error:', error)
		}

		const baseUrl = 'https://discogs-mcp-prod.rian-db8.workers.dev'

		// Check for connection ID to provide connection-specific login URL
		const connectionId = request.headers.get('X-Connection-ID')
		const loginUrl = connectionId ? `${baseUrl}/login?connection_id=${connectionId}` : `${baseUrl}/login`

		return new Response(
			JSON.stringify({
				error: 'Not authenticated',
				message: `Please visit ${loginUrl} to authenticate with Discogs first`,
			}),
			{
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			},
		)
	} catch (error) {
		console.error('MCP auth error:', error)
		return new Response(
			JSON.stringify({
				error: 'Authentication check failed',
			}),
			{
				status: 500,
				headers: addCorsHeaders({ 'Content-Type': 'application/json' }),
			},
		)
	}
}
