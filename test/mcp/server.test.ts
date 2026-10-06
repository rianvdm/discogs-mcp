// ABOUTME: Registration smoke test for the MCP server built by createMcpServer.
// ABOUTME: Snapshots the advertised tools, prompts, and resources so a bad registration change cannot pass silently.
import { env } from 'cloudflare:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, it, expect, beforeAll } from 'vitest'

import { createMcpServer } from '../../src/mcp/server'

// Tools that legitimately take no arguments. Every other tool must advertise at
// least one input property, otherwise a registration bug (schema dropped on the
// floor) would still "work" until a client passes an argument.
const ZERO_ARG_TOOLS = [
	'server_info',
	'auth_status',
	'refresh_collection',
	'get_collection_stats',
	'get_cache_stats',
	'list_folders',
	'list_custom_fields',
]

async function connectClient() {
	const { server, setContext } = createMcpServer(env as any, 'https://example.com')
	setContext({
		session: { username: 'testuser', numericId: '1', accessToken: 'test-token', accessTokenSecret: 'test-secret' },
		sessionId: 'conn-1',
	})
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'registration-smoke', version: '0.0.0' })
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
	return client
}

describe('createMcpServer registration', () => {
	let client: Client

	beforeAll(async () => {
		client = await connectClient()
	})

	it('advertises the expected tool catalogue', async () => {
		const { tools } = await client.listTools()
		const catalogue = tools
			.map((t) => ({
				name: t.name,
				description: t.description,
				properties: Object.keys(t.inputSchema.properties ?? {}).sort(),
				required: [...(t.inputSchema.required ?? [])].sort(),
				inputSchema: t.inputSchema,
			}))
			.sort((a, b) => a.name.localeCompare(b.name))

		expect(catalogue).toHaveLength(23)
		for (const tool of catalogue) {
			if (!ZERO_ARG_TOOLS.includes(tool.name)) {
				expect(tool.properties, `${tool.name} registered with an empty input schema`).not.toHaveLength(0)
			}
			expect(tool.description, `${tool.name} has no description`).toBeTruthy()
		}
		expect(catalogue).toMatchSnapshot()
	})

	it('advertises the expected prompt catalogue', async () => {
		const { prompts } = await client.listPrompts()
		const catalogue = prompts
			.map((p) => ({
				name: p.name,
				description: p.description,
				arguments: (p.arguments ?? []).map((a) => ({ name: a.name, description: a.description, required: a.required ?? false })),
			}))
			.sort((a, b) => a.name.localeCompare(b.name))

		expect(catalogue).toHaveLength(3)
		for (const prompt of catalogue) {
			expect(prompt.description, `${prompt.name} has no description`).toBeTruthy()
		}
		expect(catalogue).toMatchSnapshot()
	})

	it('advertises the expected resources and templates', async () => {
		const { resources } = await client.listResources()
		const { resourceTemplates } = await client.listResourceTemplates()
		const catalogue = {
			resources: resources
				.map((r) => ({ name: r.name, uri: r.uri, description: r.description, mimeType: r.mimeType }))
				.sort((a, b) => a.uri.localeCompare(b.uri)),
			templates: resourceTemplates
				.map((r) => ({ name: r.name, uriTemplate: r.uriTemplate, description: r.description, mimeType: r.mimeType }))
				.sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate)),
		}

		expect(catalogue.resources.length + catalogue.templates.length).toBe(3)
		expect(catalogue).toMatchSnapshot()
	})
})
