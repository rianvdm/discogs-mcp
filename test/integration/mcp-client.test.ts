import { describe, it, expect, beforeEach, vi } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/types/env'
import { createSessionToken } from '../../src/auth/jwt'
import { resetProtocolState } from '../../src/protocol/validation'
import { resetInitialization } from '../../src/protocol/handlers'

// Mock KV namespaces
const mockMCP_LOGS = {
	put: vi.fn(),
	get: vi.fn(),
	list: vi.fn(),
}

const mockMCP_RL = {
	put: vi.fn(),
	get: vi.fn(),
	list: vi.fn(),
}

const mockMCP_SESSIONS = {
	put: vi.fn(),
	get: vi.fn(),
	list: vi.fn(),
}

const mockEnv: Env = {
	DISCOGS_CONSUMER_KEY: 'test-key',
	DISCOGS_CONSUMER_SECRET: 'test-secret',
	JWT_SECRET: 'test-jwt-secret-for-integration-tests',
	MCP_LOGS: mockMCP_LOGS as any,
	MCP_RL: mockMCP_RL as any,
	MCP_SESSIONS: mockMCP_SESSIONS as any,
}

// Mock Discogs API responses
const mockDiscogsResponses = {
	collection: {
		releases: [
			{
				id: 123456,
				instance_id: 123456,
				date_added: '2023-01-01T00:00:00-08:00',
				rating: 5,
				basic_information: {
					id: 123456,
					title: 'Abbey Road',
					year: 1969,
					resource_url: 'https://api.discogs.com/releases/123456',
					thumb: '',
					cover_image: '',
					artists: [{ name: 'The Beatles', id: 1 }],
					formats: [{ name: 'Vinyl', qty: '1' }],
					genres: ['Rock'],
					styles: ['Pop Rock'],
					labels: [{ name: 'Apple Records', catno: 'PCS 7088' }],
				},
			},
			{
				id: 654321,
				instance_id: 654321,
				date_added: '2023-01-02T00:00:00-08:00',
				rating: 4,
				basic_information: {
					id: 654321,
					title: 'Dark Side of the Moon',
					year: 1973,
					resource_url: 'https://api.discogs.com/releases/654321',
					thumb: '',
					cover_image: '',
					artists: [{ name: 'Pink Floyd', id: 2 }],
					formats: [{ name: 'Vinyl', qty: '1' }],
					genres: ['Rock'],
					styles: ['Progressive Rock'],
					labels: [{ name: 'Harvest', catno: 'SHVL 804' }],
				},
			},
		],
		pagination: {
			page: 1,
			pages: 1,
			per_page: 50,
			items: 2,
			urls: {},
		},
	},
	release: {
		id: 123456,
		title: 'Abbey Road',
		artists: [{ name: 'The Beatles' }],
		year: 1969,
		formats: [{ name: 'Vinyl', qty: '1' }],
		genres: ['Rock'],
		styles: ['Pop Rock'],
		tracklist: [
			{ position: 'A1', title: 'Come Together', duration: '4:19' },
			{ position: 'A2', title: 'Something', duration: '3:03' },
		],
	},
}

/**
 * Mock MCP Client - simulates Claude Desktop or other MCP clients
 */
class MockMCPClient {
	public sessionCookie: string | null = null
	private requestId = 1

	private getNextId(): number {
		return this.requestId++
	}

	async initialize(): Promise<any> {
		const request = new Request('http://localhost:8787/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: this.getNextId(),
				method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {
						roots: { listChanged: true },
						sampling: {},
					},
					clientInfo: {
						name: 'MockMCPClient',
						version: '1.0.0',
					},
				},
			}),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)
		return await response.json()
	}

	async sendInitialized(): Promise<any> {
		const request = new Request('http://localhost:8787/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'initialized',
			}),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)
		// Notifications return 204 with no body
		if (response.status === 204) {
			return null
		}
		// If there's an error, it will have a JSON body
		if (response.status !== 200) {
			return await response.json()
		}
		return null
	}

	async authenticate(): Promise<void> {
		// Create a mock session token
		const sessionPayload = {
			userId: 'test-user-123',
			username: 'testuser',
			accessToken: 'test-access-token',
			accessTokenSecret: 'test-access-secret',
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
		}

		const sessionToken = await createSessionToken(sessionPayload, mockEnv.JWT_SECRET)
		this.sessionCookie = `session=${sessionToken}`
	}

	async listResources(): Promise<any> {
		const request = new Request('http://localhost:8787/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: this.getNextId(),
				method: 'resources/list',
			}),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)
		return await response.json()
	}

	async readResource(uri: string): Promise<any> {
		const request = new Request('http://localhost:8787/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: this.getNextId(),
				method: 'resources/read',
				params: { uri },
			}),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)
		return await response.json()
	}

	async listTools(): Promise<any> {
		const request = new Request('http://localhost:8787/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: this.getNextId(),
				method: 'tools/list',
			}),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)
		return await response.json()
	}

	async callTool(name: string, args: any = {}): Promise<any> {
		const request = new Request('http://localhost:8787/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: this.getNextId(),
				method: 'tools/call',
				params: {
					name,
					arguments: args,
				},
			}),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)
		return await response.json()
	}

	async listPrompts(): Promise<any> {
		const request = new Request('http://localhost:8787/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: this.getNextId(),
				method: 'prompts/list',
			}),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)
		return await response.json()
	}

	async getPrompt(name: string, args: any = {}): Promise<any> {
		const request = new Request('http://localhost:8787/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: this.getNextId(),
				method: 'prompts/get',
				params: {
					name,
					arguments: args,
				},
			}),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)
		return await response.json()
	}
}

describe('MCP Client Integration Tests', () => {
	let client: MockMCPClient

	beforeEach(() => {
		vi.clearAllMocks()
		client = new MockMCPClient()

		// Reset protocol state
		resetProtocolState()
		resetInitialization()

		// Mock rate limiting to allow requests
		mockMCP_RL.get.mockResolvedValue(null)
		mockMCP_RL.put.mockResolvedValue(undefined)
		mockMCP_LOGS.put.mockResolvedValue(undefined)

		// Mock Discogs API calls
		globalThis.fetch = vi.fn().mockImplementation((url: string) => {
			if (url.includes('/collection/folders/0/releases')) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve(mockDiscogsResponses.collection),
				})
			}
			if (url.includes('/releases/123456')) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve(mockDiscogsResponses.release),
				})
			}
			if (url.includes('/oauth/identity')) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							id: 123,
							username: 'testuser',
							resource_url: 'https://api.discogs.com/users/testuser',
						}),
				})
			}
			return Promise.reject(new Error(`Unmocked URL: ${url}`))
		})
	})

	describe('Full MCP Protocol Flow', () => {
		it('should complete full initialization handshake', async () => {
			// Step 1: Initialize
			const initResult = await client.initialize()

			expect(initResult).toMatchObject({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2024-11-05',
					capabilities: {
						resources: { subscribe: false, listChanged: true },
						tools: { listChanged: true },
						prompts: { listChanged: true },
						logging: {},
					},
					serverInfo: {
						name: 'discogs-mcp',
						version: '1.0.0',
					},
				},
			})

			// Step 2: Send initialized notification
			const initNotification = await client.sendInitialized()
			expect(initNotification).toBeNull() // Notifications don't return responses
		})

		it('should handle unauthenticated access to protected resources', async () => {
			// Initialize first
			await client.initialize()
			await client.sendInitialized()

			// Try to access protected resource without authentication
			const result = await client.readResource('discogs://collection')

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				id: 2,
				error: {
					code: -32001, // Unauthorized
					message:
						'Authentication required. Please use the "auth_status" tool for detailed authentication instructions, or visit https://discogs-mcp-prod.rian-db8.workers.dev/login to authenticate with Discogs',
				},
			})
		})

		it('should allow authenticated access to all features', async () => {
			// Initialize
			await client.initialize()
			await client.sendInitialized()

			// Authenticate
			await client.authenticate()

			// Test resources
			const resourcesList = await client.listResources()
			expect(resourcesList.result.resources).toHaveLength(3)

			const collectionResource = await client.readResource('discogs://collection')
			expect(collectionResource.result.contents).toBeDefined()
			expect(collectionResource.result.contents[0].text).toContain('Abbey Road')

			// Test tools
			const toolsList = await client.listTools()
			expect(toolsList.result.tools).toHaveLength(8) // ping, server_info, auth_status, search_collection, get_release, get_collection_stats, get_recommendations, get_cache_stats

			const searchResult = await client.callTool('search_collection', { query: 'Beatles' })
			console.log('Search result:', JSON.stringify(searchResult, null, 2))
			expect(searchResult.result).toBeDefined()
			if (searchResult.result.content) {
				expect(searchResult.result.content[0].text).toContain('Abbey Road')
			} else {
				// If there's an error, log it
				console.log('Search result error:', searchResult.error)
				expect(searchResult.error).toBeUndefined()
			}

			const releaseResult = await client.callTool('get_release', { release_id: '123456' })
			console.log('Release result:', JSON.stringify(releaseResult, null, 2))
			if (releaseResult.result?.content) {
				expect(releaseResult.result.content[0].text).toContain('Abbey Road')
			} else {
				console.log('Release result error:', releaseResult.error)
				expect(releaseResult.error).toBeUndefined()
			}

			const statsResult = await client.callTool('get_collection_stats')
			expect(statsResult.result).toBeDefined()
			expect(statsResult.result.content).toBeDefined()
			expect(statsResult.result.content[0].text).toContain('Collection Statistics')

			// Test prompts
			const promptsList = await client.listPrompts()
			expect(promptsList.result.prompts).toHaveLength(3)

			const browsePrompt = await client.getPrompt('browse_collection')
			expect(browsePrompt.result.messages).toBeDefined()
			expect(browsePrompt.result.messages[0].content.text).toContain('music collection')
		})

		it('should handle tool parameter validation', async () => {
			await client.initialize()
			await client.sendInitialized()
			await client.authenticate()

			// Test missing required parameter
			const result = await client.callTool('get_release', {})

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				id: 2,
				error: {
					code: -32602, // Invalid params
					message: expect.stringContaining('release_id'),
				},
			})
		})

		it('should handle unknown methods gracefully', async () => {
			await client.initialize()
			await client.sendInitialized()
			await client.authenticate()

			const request = new Request('http://localhost:8787/', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Cookie: client.sessionCookie || '',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 99,
					method: 'unknown/method',
					params: {},
				}),
			})

			const response = await worker.fetch(request, mockEnv, {} as any)
			const result = await response.json()

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				id: 99,
				error: {
					code: -32601, // Method not found
					message: 'Method not found',
				},
			})
		})

		it('should maintain session state across requests', async () => {
			await client.initialize()
			await client.sendInitialized()
			await client.authenticate()

			// Make multiple authenticated requests
			const result1 = await client.callTool('search_collection', { query: 'Beatles' })
			const result2 = await client.callTool('get_collection_stats')
			const result3 = await client.readResource('discogs://collection')

			// All should succeed
			expect(result1.result).toBeDefined()
			expect(result2.result).toBeDefined()
			expect(result3.result).toBeDefined()

			// Verify no authentication errors
			expect(result1.error).toBeUndefined()
			expect(result2.error).toBeUndefined()
			expect(result3.error).toBeUndefined()
		})

		it('should handle concurrent requests properly', async () => {
			await client.initialize()
			await client.sendInitialized()
			await client.authenticate()

			// Make multiple concurrent requests
			const promises = [
				client.callTool('ping', { message: 'test1' }),
				client.callTool('ping', { message: 'test2' }),
				client.callTool('server_info'),
			]

			const results = await Promise.all(promises)

			// All should succeed
			results.forEach((result) => {
				expect(result.error).toBeUndefined()
				expect(result.result).toBeDefined()
			})

			// Verify unique request IDs were handled correctly
			const ids = results.map((r) => r.id).filter((id) => id !== undefined)
			expect(new Set(ids).size).toBe(ids.length) // All IDs should be unique
		})
	})

	describe('Error Handling', () => {
		it('should handle malformed JSON gracefully', async () => {
			const request = new Request('http://localhost:8787/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'invalid json{',
			})

			const response = await worker.fetch(request, mockEnv, {} as any)
			const result = await response.json()

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				id: null,
				error: {
					code: -32700, // Parse error
					message: 'Parse error',
				},
			})
		})

		it('should handle network errors to Discogs API', async () => {
			await client.initialize()
			await client.sendInitialized()
			await client.authenticate()

			// Mock network error
			globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

			const result = await client.callTool('search_collection', { query: 'test' })

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				id: 2,
				error: {
					code: -32008, // Discogs API error
					message: 'Discogs API error',
				},
			})
		}, 20000) // Increase timeout to 20 seconds to account for retry delays (3 retries with exponential backoff)

		it('should handle rate limiting correctly', async () => {
			// Mock rate limit exceeded
			mockMCP_RL.get.mockResolvedValue('61') // Over limit of 60

			await client.initialize()
			await client.sendInitialized()

			const result = await client.listTools()

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				id: 2,
				error: {
					code: -32000, // Rate limited
					message: expect.stringContaining('Rate limit exceeded'),
				},
			})
		})
	})

	describe('Protocol Compliance', () => {
		it('should allow tools/list without initialization (stateless mode)', async () => {
			// Try to call method without initializing - should work in stateless mode
			const result = await client.listTools()

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				id: 1,
				result: {
					tools: expect.any(Array),
				},
			})
		})

		it('should validate JSON-RPC message format', async () => {
			const request = new Request('http://localhost:8787/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// Missing jsonrpc field
					id: 1,
					method: 'initialize',
					params: {},
				}),
			})

			const response = await worker.fetch(request, mockEnv, {} as any)
			const result = await response.json()

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				id: null,
				error: {
					code: -32600, // Invalid request
					message: 'Invalid Request',
				},
			})
		})

		it('should handle notifications without returning responses', async () => {
			await client.initialize()

			const request = new Request('http://localhost:8787/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'initialized',
					// No id field = notification
				}),
			})

			const response = await worker.fetch(request, mockEnv, {} as any)

			// Notifications should return 204 with no body
			expect(response.status).toBe(204)
			const text = await response.text()
			expect(text).toBe('') // Empty response for notifications
		})
	})
})
