// ABOUTME: OAuth 2.1 Authorization Code flow with PKCE implementation
// ABOUTME: Handles authorization endpoint, token endpoint, and PKCE validation per RFC 7636

import type { Env } from '../types/env'
import { getOAuthClient } from './registration'
import { verifyAuthentication } from '../protocol/handlers'

export interface AuthorizationRequest {
	response_type: string
	client_id: string
	redirect_uri: string
	scope?: string
	state?: string
	code_challenge: string
	code_challenge_method: string
}

export interface TokenRequest {
	grant_type: string
	code?: string
	redirect_uri?: string
	client_id: string
	client_secret?: string
	code_verifier?: string
	refresh_token?: string
}

export interface AuthorizationCode {
	code: string
	client_id: string
	redirect_uri: string
	scope?: string
	code_challenge: string
	code_challenge_method: string
	user_id: string
	expires_at: number
	created_at: number
}

export interface AccessToken {
	access_token: string
	refresh_token?: string
	token_type: 'Bearer'
	expires_in: number
	scope?: string
	user_id: string
	client_id: string
	created_at: number
}

/**
 * Generate a cryptographically secure authorization code
 */
function generateAuthorizationCode(): string {
	const array = new Uint8Array(32)
	crypto.getRandomValues(array)
	return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a cryptographically secure access token
 */
function generateAccessToken(): string {
	const array = new Uint8Array(32)
	crypto.getRandomValues(array)
	return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a cryptographically secure refresh token
 */
function generateRefreshToken(): string {
	const array = new Uint8Array(32)
	crypto.getRandomValues(array)
	return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Validate PKCE code challenge
 */
async function validatePKCE(codeVerifier: string, codeChallenge: string, codeChallengeMethod: string): Promise<boolean> {
	if (codeChallengeMethod !== 'S256') {
		return false
	}

	try {
		// Create SHA256 hash of code verifier
		const encoder = new TextEncoder()
		const data = encoder.encode(codeVerifier)
		const hashBuffer = await crypto.subtle.digest('SHA-256', data)
		
		// Convert to base64url
		const hashArray = new Uint8Array(hashBuffer)
		const base64 = btoa(String.fromCharCode.apply(null, Array.from(hashArray)))
		const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
		
		return base64url === codeChallenge
	} catch (error) {
		console.error('PKCE validation error:', error)
		return false
	}
}

/**
 * Handle OAuth 2.1 Authorization request
 */
export async function handleAuthorizationRequest(request: Request, env: Env): Promise<Response> {
	try {
		const url = new URL(request.url)
		
		// Extract authorization parameters
		const responseType = url.searchParams.get('response_type')
		const clientId = url.searchParams.get('client_id')
		const redirectUri = url.searchParams.get('redirect_uri')
		const scope = url.searchParams.get('scope')
		const state = url.searchParams.get('state')
		const codeChallenge = url.searchParams.get('code_challenge')
		const codeChallengeMethod = url.searchParams.get('code_challenge_method')

		// Validate required parameters
		if (!responseType || !clientId || !redirectUri || !codeChallenge || !codeChallengeMethod) {
			return new Response(
				JSON.stringify({
					error: 'invalid_request',
					error_description: 'Missing required parameters: response_type, client_id, redirect_uri, code_challenge, code_challenge_method',
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Validate response type
		if (responseType !== 'code') {
			return new Response(
				JSON.stringify({
					error: 'unsupported_response_type',
					error_description: 'Only authorization code flow is supported',
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Validate PKCE method
		if (codeChallengeMethod !== 'S256') {
			return new Response(
				JSON.stringify({
					error: 'invalid_request',
					error_description: 'Only S256 code challenge method is supported',
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Validate client
		const client = await getOAuthClient(clientId, env)
		if (!client) {
			return new Response(
				JSON.stringify({
					error: 'invalid_client',
					error_description: 'Invalid client_id',
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Validate redirect URI
		if (!client.redirect_uris.includes(redirectUri)) {
			return new Response(
				JSON.stringify({
					error: 'invalid_request',
					error_description: 'Invalid redirect_uri',
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Check if user is already authenticated via existing JWT session
		const existingSession = await verifyAuthentication(request, env.JWT_SECRET)
		
		if (existingSession) {
			// User is already authenticated, generate authorization code
			const authCode = generateAuthorizationCode()
			const authorizationCode: AuthorizationCode = {
				code: authCode,
				client_id: clientId,
				redirect_uri: redirectUri,
				scope,
				code_challenge: codeChallenge,
				code_challenge_method: codeChallengeMethod,
				user_id: existingSession.userId,
				expires_at: Date.now() + (10 * 60 * 1000), // 10 minutes
				created_at: Date.now(),
			}

			// Store authorization code
			if (env.DISCOGS_OAUTH_TOKENS) {
				await env.DISCOGS_OAUTH_TOKENS.put(`auth_code:${authCode}`, JSON.stringify(authorizationCode), {
					expirationTtl: 10 * 60, // 10 minutes
				})
			}

			// Redirect back to client with authorization code
			const redirectUrl = new URL(redirectUri)
			redirectUrl.searchParams.set('code', authCode)
			if (state) {
				redirectUrl.searchParams.set('state', state)
			}

			return Response.redirect(redirectUrl.toString(), 302)
		}

		// User not authenticated, redirect to Discogs OAuth with connection tracking
		const baseUrl = `${url.protocol}//${url.host}`
		const connectionId = `oauth2-${clientId}-${Date.now()}`
		
		// Store OAuth 2.1 authorization request for after Discogs authentication
		const authRequest: AuthorizationRequest = {
			response_type: responseType,
			client_id: clientId,
			redirect_uri: redirectUri,
			scope,
			state,
			code_challenge: codeChallenge,
			code_challenge_method: codeChallengeMethod,
		}

		if (env.DISCOGS_OAUTH_TOKENS) {
			await env.DISCOGS_OAUTH_TOKENS.put(`auth_request:${connectionId}`, JSON.stringify(authRequest), {
				expirationTtl: 10 * 60, // 10 minutes
			})
		}

		// Redirect to Discogs OAuth with connection tracking
		const discogsLoginUrl = `${baseUrl}/login?connection_id=${connectionId}`
		return Response.redirect(discogsLoginUrl, 302)

	} catch (error) {
		console.error('OAuth authorization error:', error)
		
		return new Response(
			JSON.stringify({
				error: 'server_error',
				error_description: 'Internal server error during authorization',
			}),
			{
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			},
		)
	}
}

/**
 * Handle OAuth 2.1 Token request
 */
export async function handleTokenRequest(request: Request, env: Env): Promise<Response> {
	try {
		// Parse token request
		const body = await request.text()
		const params = new URLSearchParams(body)
		
		const grantType = params.get('grant_type')
		const code = params.get('code')
		const redirectUri = params.get('redirect_uri')
		const clientId = params.get('client_id')
		const clientSecret = params.get('client_secret')
		const codeVerifier = params.get('code_verifier')
		const _refreshToken = params.get('refresh_token')

		// Validate grant type
		if (!grantType || !['authorization_code', 'refresh_token'].includes(grantType)) {
			return new Response(
				JSON.stringify({
					error: 'unsupported_grant_type',
					error_description: 'Only authorization_code and refresh_token grant types are supported',
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Validate client
		if (!clientId) {
			return new Response(
				JSON.stringify({
					error: 'invalid_request',
					error_description: 'client_id is required',
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		const client = await getOAuthClient(clientId, env)
		if (!client) {
			return new Response(
				JSON.stringify({
					error: 'invalid_client',
					error_description: 'Invalid client_id',
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Validate client secret if required
		if (client.token_endpoint_auth_method !== 'none' && client.client_secret !== clientSecret) {
			return new Response(
				JSON.stringify({
					error: 'invalid_client',
					error_description: 'Invalid client credentials',
				}),
				{
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		if (grantType === 'authorization_code') {
			// Authorization code flow
			if (!code || !redirectUri || !codeVerifier) {
				return new Response(
					JSON.stringify({
						error: 'invalid_request',
						error_description: 'Missing required parameters: code, redirect_uri, code_verifier',
					}),
					{
						status: 400,
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*',
						},
					},
				)
			}

			// Retrieve authorization code
			const authCodeData = env.DISCOGS_OAUTH_TOKENS ? await env.DISCOGS_OAUTH_TOKENS.get(`auth_code:${code}`) : null
			if (!authCodeData) {
				return new Response(
					JSON.stringify({
						error: 'invalid_grant',
						error_description: 'Invalid or expired authorization code',
					}),
					{
						status: 400,
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*',
						},
					},
				)
			}

			const authCode: AuthorizationCode = JSON.parse(authCodeData)

			// Validate authorization code
			if (authCode.client_id !== clientId || authCode.redirect_uri !== redirectUri) {
				return new Response(
					JSON.stringify({
						error: 'invalid_grant',
						error_description: 'Authorization code does not match client or redirect URI',
					}),
					{
						status: 400,
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*',
						},
					},
				)
			}

			// Validate PKCE
			const pkceValid = await validatePKCE(codeVerifier, authCode.code_challenge, authCode.code_challenge_method)
			if (!pkceValid) {
				return new Response(
					JSON.stringify({
						error: 'invalid_grant',
						error_description: 'Invalid PKCE code verifier',
					}),
					{
						status: 400,
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*',
						},
					},
				)
			}

			// Generate access token
			const accessToken = generateAccessToken()
			const refreshTokenValue = generateRefreshToken()
			const expiresIn = 3600 // 1 hour

			const tokenData: AccessToken = {
				access_token: accessToken,
				refresh_token: refreshTokenValue,
				token_type: 'Bearer',
				expires_in: expiresIn,
				scope: authCode.scope,
				user_id: authCode.user_id,
				client_id: clientId,
				created_at: Date.now(),
			}

			// Store tokens
			if (env.DISCOGS_OAUTH_TOKENS) {
				await env.DISCOGS_OAUTH_TOKENS.put(`access_token:${accessToken}`, JSON.stringify(tokenData), {
					expirationTtl: expiresIn,
				})
				await env.DISCOGS_OAUTH_TOKENS.put(`refresh_token:${refreshTokenValue}`, JSON.stringify(tokenData), {
					expirationTtl: 30 * 24 * 60 * 60, // 30 days
				})
				
				// Clean up authorization code
				await env.DISCOGS_OAUTH_TOKENS.delete(`auth_code:${code}`)
			}

			// Return token response
			return new Response(
				JSON.stringify({
					access_token: accessToken,
					refresh_token: refreshTokenValue,
					token_type: 'Bearer',
					expires_in: expiresIn,
					scope: authCode.scope,
				}),
				{
					status: 200,
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': 'no-store',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Refresh token flow not implemented yet
		return new Response(
			JSON.stringify({
				error: 'unsupported_grant_type',
				error_description: 'Refresh token flow not yet implemented',
			}),
			{
				status: 400,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			},
		)

	} catch (error) {
		console.error('OAuth token error:', error)
		
		return new Response(
			JSON.stringify({
				error: 'server_error',
				error_description: 'Internal server error during token exchange',
			}),
			{
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			},
		)
	}
}

/**
 * Get access token by token value
 */
export async function getAccessToken(token: string, env: Env): Promise<AccessToken | null> {
	if (!env.DISCOGS_OAUTH_TOKENS) {
		return null
	}

	try {
		const tokenData = await env.DISCOGS_OAUTH_TOKENS.get(`access_token:${token}`)
		if (!tokenData) {
			return null
		}

		return JSON.parse(tokenData) as AccessToken
	} catch (error) {
		console.error('Error retrieving access token:', error)
		return null
	}
}