// ABOUTME: Unified authentication middleware supporting both JWT cookies and OAuth 2.1 Bearer tokens
// ABOUTME: Provides seamless authentication for both existing users and Claude Custom Integrations

import { verifyAuthentication } from '../protocol/handlers'
import { getAccessToken } from './oauth2'
import type { Env } from '../types/env'

export interface AuthenticationResult {
	isAuthenticated: boolean
	userId?: string
	authMethod?: 'jwt' | 'bearer'
	accessToken?: string
	accessTokenSecret?: string
	error?: string
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(request: Request): string | null {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader) {
		return null
	}

	const parts = authHeader.split(' ')
	if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
		return null
	}

	return parts[1]
}

/**
 * Verify OAuth 2.1 Bearer token
 */
async function verifyBearerToken(token: string, env: Env): Promise<AuthenticationResult> {
	try {
		const tokenData = await getAccessToken(token, env)
		if (!tokenData) {
			return {
				isAuthenticated: false,
				error: 'Invalid or expired access token',
			}
		}

		// Check if token is expired
		const now = Date.now()
		const expiresAt = tokenData.created_at + (tokenData.expires_in * 1000)
		if (now >= expiresAt) {
			return {
				isAuthenticated: false,
				error: 'Access token has expired',
			}
		}

		return {
			isAuthenticated: true,
			userId: tokenData.user_id,
			authMethod: 'bearer',
		}
	} catch (error) {
		console.error('Bearer token verification error:', error)
		return {
			isAuthenticated: false,
			error: 'Token verification failed',
		}
	}
}

/**
 * Verify JWT session from cookie
 */
async function verifyJWTAuth(request: Request, jwtSecret: string): Promise<AuthenticationResult> {
	try {
		const session = await verifyAuthentication(request, jwtSecret)
		if (!session) {
			return {
				isAuthenticated: false,
				error: 'Invalid or missing JWT session',
			}
		}

		return {
			isAuthenticated: true,
			userId: session.userId,
			authMethod: 'jwt',
			accessToken: session.accessToken,
			accessTokenSecret: session.accessTokenSecret,
		}
	} catch (error) {
		console.error('JWT verification error:', error)
		return {
			isAuthenticated: false,
			error: 'JWT verification failed',
		}
	}
}

/**
 * Unified authentication function that supports both JWT and Bearer token auth
 */
export async function authenticateRequest(request: Request, env: Env): Promise<AuthenticationResult> {
	// Try Bearer token authentication first
	const bearerToken = extractBearerToken(request)
	if (bearerToken) {
		const bearerResult = await verifyBearerToken(bearerToken, env)
		if (bearerResult.isAuthenticated) {
			return bearerResult
		}
		
		// If Bearer token was provided but invalid, don't fall back to JWT
		// This prevents security issues where malformed Bearer tokens bypass auth
		return bearerResult
	}

	// Try JWT authentication as fallback
	if (env.JWT_SECRET) {
		const jwtResult = await verifyJWTAuth(request, env.JWT_SECRET)
		if (jwtResult.isAuthenticated) {
			return jwtResult
		}
	}

	// No valid authentication found
	return {
		isAuthenticated: false,
		error: 'No valid authentication provided',
	}
}

/**
 * Create an authentication middleware that can be used in request handlers
 */
export function createAuthMiddleware(env: Env) {
	return async (request: Request): Promise<AuthenticationResult> => {
		return authenticateRequest(request, env)
	}
}

/**
 * Check if a request has MCP protocol version header
 */
export function getMCPProtocolVersion(request: Request): string | null {
	return request.headers.get('MCP-Protocol-Version')
}

/**
 * Validate MCP protocol version
 */
export function isValidMCPProtocolVersion(version: string | null): boolean {
	if (!version) {
		return true // Protocol version is optional
	}

	// Support current MCP protocol versions
	const supportedVersions = ['2024-11-05', '2024-10-07']
	return supportedVersions.includes(version)
}