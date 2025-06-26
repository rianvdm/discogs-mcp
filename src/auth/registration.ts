// ABOUTME: OAuth 2.1 Dynamic Client Registration implementation per RFC 7591
// ABOUTME: Allows Claude Custom Integrations to register as OAuth clients automatically

import type { Env } from '../types/env'

export interface ClientRegistrationRequest {
	client_name?: string
	client_uri?: string
	redirect_uris: string[]
	grant_types?: string[]
	response_types?: string[]
	scope?: string
	token_endpoint_auth_method?: string
	logo_uri?: string
	contacts?: string[]
	tos_uri?: string
	policy_uri?: string
	software_id?: string
	software_version?: string
}

export interface OAuthClient {
	client_id: string
	client_secret?: string
	client_name: string
	client_uri?: string
	redirect_uris: string[]
	grant_types: string[]
	response_types: string[]
	scope?: string
	token_endpoint_auth_method: string
	logo_uri?: string
	contacts?: string[]
	tos_uri?: string
	policy_uri?: string
	software_id?: string
	software_version?: string
	created_at: number
	client_id_issued_at: number
	client_secret_expires_at?: number
}

export interface ClientRegistrationResponse {
	client_id: string
	client_secret?: string
	client_name: string
	client_uri?: string
	redirect_uris: string[]
	grant_types: string[]
	response_types: string[]
	scope?: string
	token_endpoint_auth_method: string
	logo_uri?: string
	contacts?: string[]
	tos_uri?: string
	policy_uri?: string
	software_id?: string
	software_version?: string
	client_id_issued_at: number
	client_secret_expires_at?: number
}

/**
 * Generate a cryptographically secure client ID
 */
function generateClientId(): string {
	const array = new Uint8Array(16)
	crypto.getRandomValues(array)
	return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a cryptographically secure client secret
 */
function generateClientSecret(): string {
	const array = new Uint8Array(32)
	crypto.getRandomValues(array)
	return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Validate redirect URIs according to OAuth 2.1 security requirements
 */
function validateRedirectUris(redirectUris: string[]): { valid: boolean; error?: string } {
	if (!redirectUris || redirectUris.length === 0) {
		return { valid: false, error: 'redirect_uris is required' }
	}

	for (const uri of redirectUris) {
		try {
			const url = new URL(uri)
			
			// OAuth 2.1 requires HTTPS for redirect URIs (except localhost)
			if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
				return { 
					valid: false, 
					error: `redirect_uri must use HTTPS or be localhost: ${uri}` 
				}
			}

			// No fragments allowed in redirect URIs
			if (url.hash) {
				return { 
					valid: false, 
					error: `redirect_uri must not contain fragment: ${uri}` 
				}
			}
		} catch {
			return { valid: false, error: `Invalid redirect_uri format: ${uri}` }
		}
	}

	return { valid: true }
}

/**
 * Handle OAuth 2.1 Dynamic Client Registration
 */
export async function handleClientRegistration(request: Request, env: Env): Promise<Response> {
	try {
		// Only allow POST requests
		if (request.method !== 'POST') {
			return new Response(
				JSON.stringify({
					error: 'invalid_request',
					error_description: 'Only POST method is allowed for client registration',
				}),
				{
					status: 405,
					headers: {
						'Content-Type': 'application/json',
						'Allow': 'POST',
						'Access-Control-Allow-Origin': '*',
					},
				},
			)
		}

		// Parse request body
		let registrationRequest: ClientRegistrationRequest
		try {
			const body = await request.text()
			if (!body) {
				throw new Error('Empty request body')
			}
			registrationRequest = JSON.parse(body)
		} catch {
			return new Response(
				JSON.stringify({
					error: 'invalid_request',
					error_description: 'Invalid JSON in request body',
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

		// Validate redirect URIs
		const redirectValidation = validateRedirectUris(registrationRequest.redirect_uris)
		if (!redirectValidation.valid) {
			return new Response(
				JSON.stringify({
					error: 'invalid_redirect_uri',
					error_description: redirectValidation.error,
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

		// Set defaults for optional fields
		const grantTypes = registrationRequest.grant_types || ['authorization_code']
		const responseTypes = registrationRequest.response_types || ['code']
		const tokenEndpointAuthMethod = registrationRequest.token_endpoint_auth_method || 'client_secret_basic'
		const clientName = registrationRequest.client_name || 'MCP Client'

		// Validate grant types
		const supportedGrantTypes = ['authorization_code', 'refresh_token']
		for (const grantType of grantTypes) {
			if (!supportedGrantTypes.includes(grantType)) {
				return new Response(
					JSON.stringify({
						error: 'invalid_client_metadata',
						error_description: `Unsupported grant_type: ${grantType}`,
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
		}

		// Validate response types
		const supportedResponseTypes = ['code']
		for (const responseType of responseTypes) {
			if (!supportedResponseTypes.includes(responseType)) {
				return new Response(
					JSON.stringify({
						error: 'invalid_client_metadata',
						error_description: `Unsupported response_type: ${responseType}`,
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
		}

		// Generate client credentials
		const clientId = generateClientId()
		const clientSecret = tokenEndpointAuthMethod === 'none' ? undefined : generateClientSecret()
		const now = Math.floor(Date.now() / 1000)

		// Create client record
		const client: OAuthClient = {
			client_id: clientId,
			client_secret: clientSecret,
			client_name: clientName,
			client_uri: registrationRequest.client_uri,
			redirect_uris: registrationRequest.redirect_uris,
			grant_types: grantTypes,
			response_types: responseTypes,
			scope: registrationRequest.scope,
			token_endpoint_auth_method: tokenEndpointAuthMethod,
			logo_uri: registrationRequest.logo_uri,
			contacts: registrationRequest.contacts,
			tos_uri: registrationRequest.tos_uri,
			policy_uri: registrationRequest.policy_uri,
			software_id: registrationRequest.software_id,
			software_version: registrationRequest.software_version,
			created_at: Date.now(),
			client_id_issued_at: now,
			client_secret_expires_at: clientSecret ? now + (365 * 24 * 60 * 60) : undefined, // 1 year
		}

		// Store client in KV
		if (env.DISCOGS_OAUTH_CLIENTS) {
			await env.DISCOGS_OAUTH_CLIENTS.put(`client:${clientId}`, JSON.stringify(client), {
				expirationTtl: 365 * 24 * 60 * 60, // 1 year
			})
		}

		// Prepare response
		const response: ClientRegistrationResponse = {
			client_id: client.client_id,
			client_secret: client.client_secret,
			client_name: client.client_name,
			client_uri: client.client_uri,
			redirect_uris: client.redirect_uris,
			grant_types: client.grant_types,
			response_types: client.response_types,
			scope: client.scope,
			token_endpoint_auth_method: client.token_endpoint_auth_method,
			logo_uri: client.logo_uri,
			contacts: client.contacts,
			tos_uri: client.tos_uri,
			policy_uri: client.policy_uri,
			software_id: client.software_id,
			software_version: client.software_version,
			client_id_issued_at: client.client_id_issued_at,
			client_secret_expires_at: client.client_secret_expires_at,
		}

		console.log(`Registered new OAuth client: ${clientId} (${clientName})`)

		return new Response(JSON.stringify(response, null, 2), {
			status: 201,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
				'Access-Control-Allow-Origin': '*',
			},
		})
	} catch (error) {
		console.error('Client registration error:', error)

		return new Response(
			JSON.stringify({
				error: 'server_error',
				error_description: 'Internal server error during client registration',
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
 * Get OAuth client by client ID
 */
export async function getOAuthClient(clientId: string, env: Env): Promise<OAuthClient | null> {
	if (!env.DISCOGS_OAUTH_CLIENTS) {
		return null
	}

	try {
		const clientData = await env.DISCOGS_OAUTH_CLIENTS.get(`client:${clientId}`)
		if (!clientData) {
			return null
		}

		return JSON.parse(clientData) as OAuthClient
	} catch (error) {
		console.error('Error retrieving OAuth client:', error)
		return null
	}
}