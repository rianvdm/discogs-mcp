import { describe, it, expect, beforeEach, vi } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/types/env'
import { createSessionToken } from '../../src/auth/jwt'

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
 * Parse SSE (Server-Sent Events) response format
 */
function parseSSE(text: string): any | null {
	if (!text) return null

	const lines = text.split('\n')
	for (const line of lines) {
		if (line.startsWith('data:')) {
			const jsonStr = line.substring(5).trim()
			try {
				return JSON.parse(jsonStr)
			} catch (e) {
				console.error('Failed to parse SSE data:', line)
				return null
			}
		}
	}
	return null
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

	private async makeRequest(body: any): Promise<any> {
		const request = new Request('http://localhost:8787/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json, text/event-stream',
				...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
			},
			body: JSON.stringify(body),
		})

		const response = await worker.fetch(request, mockEnv, {} as any)

		// Handle status codes that don't have a response body
		if (response.status === 204 || response.status === 202) {
			// 204: No Content (notifications)
			// 202: Accepted (streaming started, but we're in test mode so no stream to read)
			return null
		}

		const text = await response.text()
		console.log('Response status:', response.status, 'Text length:', text.length, 'Text:', text.substring(0, 200))

		// Try SSE format first
		const sseData = parseSSE(text)
		if (sseData) {
			return sseData
		}

		// Fall back to plain JSON
		try {
			return JSON.parse(text)
		} catch (e) {
			if (text) {
				console.error('Failed to parse response:', text.substring(0, 500))
				throw new Error(`Invalid response format: ${text.substring(0, 100)}`)
			}
			// Empty response is also invalid for non-204/202 status
			throw new Error(`Empty response body (status: ${response.status})`)
		}
	}

	async initialize(): Promise<any> {
		return this.makeRequest({
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
		})
	}

	async sendInitialized(): Promise<any> {
		return this.makeRequest({
			jsonrpc: '2.0',
			method: 'initialized',
		})
	}

	async authenticate(): Promise<void> {
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
		return this.makeRequest({
			jsonrpc: '2.0',
			id: this.getNextId(),
			method: 'resources/list',
		})
	}

	async readResource(uri: string): Promise<any> {
		return this.makeRequest({
			jsonrpc: '2.0',
			id: this.getNextId(),
			method: 'resources/read',
			params: { uri },
		})
	}

	async listTools(): Promise<any> {
		return this.makeRequest({
			jsonrpc: '2.0',
			id: this.getNextId(),
			method: 'tools/list',
		})
	}

	async callTool(name: string, args: any = {}): Promise<any> {
		return this.makeRequest({
			jsonrpc: '2.0',
			id: this.getNextId(),
			method: 'tools/call',
			params: {
				name,
				arguments: args,
			},
		})
	}

	async listPrompts(): Promise<any> {
		return this.makeRequest({
			jsonrpc: '2.0',
			id: this.getNextId(),
			method: 'prompts/list',
		})
	}

	async getPrompt(name: string, args: any = {}): Promise<any> {
		return this.makeRequest({
			jsonrpc: '2.0',
			id: this.getNextId(),
			method: 'prompts/get',
			params: {
				name,
				arguments: args,
			},
		})
	}
}

describe('MCP Client Integration Tests', () => {
	let client: MockMCPClient

	beforeEach(() => {
		vi.clearAllMocks()
		client = new MockMCPClient()

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
			const initResult = await client.initialize()

			expect(initResult).toMatchObject({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2024-11-05',
					capabilities: {
						resources: { listChanged: true },
						tools: { listChanged: true },
						prompts: { listChanged: true },
					},
					serverInfo: {
						name: 'discogs-mcp',
						version: '1.0.0',
					},
				},
			})

			const initNotification = await client.sendInitialized()
			expect(initNotification).toBeNull()
		})

		it('should handle unauthenticated access to protected resources', async () => {
			await client.initialize()
			await client.sendInitialized()

			const result = await client.readResource('discogs://collection')

			expect(result).toMatchObject({
				jsonrpc: '2.0',
				error: {
					code: -32603,
				},
			})
		})

		it('should allow authenticated access to all features', async () => {
			await client.initialize()
			await client.authenticate()

			// Test resources
			const resourcesList = await client.listResources()
			expect(resourcesList.result.resources).toHaveLength(1) // Only concrete resource (collection)

			const collectionResource = await client.readResource('discogs://collection')
			expect(collectionResource.result.contents).toBeDefined()

			// Test tools
			const toolsList = await client.listTools()
			expect(toolsList.result.tools).toHaveLength(8)

			const searchResult = await client.callTool('search_collection', { query: 'Beatles' })
			expect(searchResult.result).toBeDefined()

			// Test prompts
			const promptsList = await client.listPrompts()
			expect(promptsList.result.prompts).toHaveLength(3)
		})
	})
})
