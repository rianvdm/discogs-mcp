// ABOUTME: OAuth 2.1 Authorization Server Metadata endpoint implementation
// ABOUTME: Provides discovery information for Claude Custom Integrations per RFC 8414

import type { Env } from '../types/env'

export interface AuthorizationServerMetadata {
	issuer: string
	authorization_endpoint: string
	token_endpoint: string
	registration_endpoint: string
	scopes_supported?: string[]
	response_types_supported: string[]
	grant_types_supported: string[]
	token_endpoint_auth_methods_supported: string[]
	code_challenge_methods_supported: string[]
	revocation_endpoint?: string
	introspection_endpoint?: string
	service_documentation?: string
}

/**
 * Generate OAuth 2.1 Authorization Server Metadata
 * This endpoint allows Claude to discover our OAuth capabilities
 */
export function generateAuthorizationServerMetadata(baseUrl: string): AuthorizationServerMetadata {
	return {
		issuer: baseUrl,
		authorization_endpoint: `${baseUrl}/oauth/authorize`,
		token_endpoint: `${baseUrl}/oauth/token`,
		registration_endpoint: `${baseUrl}/oauth/register`,
		scopes_supported: [
			'discogs:read', // Read access to Discogs collection
			'discogs:collection', // Full collection access (read-only for now)
		],
		response_types_supported: ['code'],
		grant_types_supported: [
			'authorization_code',
			'refresh_token',
		],
		token_endpoint_auth_methods_supported: [
			'client_secret_basic',
			'client_secret_post',
			'none', // For public clients (Claude Desktop)
		],
		code_challenge_methods_supported: ['S256'], // PKCE with SHA256
		service_documentation: `${baseUrl}/`,
	}
}

/**
 * Handle OAuth Authorization Server Metadata request
 */
export async function handleMetadataRequest(request: Request, env: Env): Promise<Response> {
	try {
		// Get base URL from request
		const url = new URL(request.url)
		const baseUrl = `${url.protocol}//${url.host}`

		// Generate metadata
		const metadata = generateAuthorizationServerMetadata(baseUrl)

		// Return metadata with proper headers
		return new Response(JSON.stringify(metadata, null, 2), {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET',
				'Access-Control-Allow-Headers': 'Content-Type',
			},
		})
	} catch (error) {
		console.error('OAuth metadata error:', error)
		
		return new Response(
			JSON.stringify({
				error: 'server_error',
				error_description: 'Failed to generate authorization server metadata',
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