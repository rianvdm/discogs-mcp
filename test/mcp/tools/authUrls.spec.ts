import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createMcpServer } from '../../../src/mcp/server'

// Self-hosted deployments run on their own hostname; every login URL the
// server hands out must point there, never at the maintainer's instance.
const SELF_HOST = 'https://discogs.example.net'

type Handler = (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>

async function callTool(name: string, args: unknown = {}): Promise<string> {
	const { server, setContext } = createMcpServer(env as any, SELF_HOST)
	setContext({ session: null, sessionId: 'conn-42' })
	const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools
	const tool = tools[name]
	if (!tool) throw new Error(`${name} tool not registered`)
	const res = await tool.handler(args, {})
	return res.content.map((c) => c.text).join('\n')
}

describe('login URLs follow the deployment host', () => {
	it('auth_status points an unauthenticated user at this deployment', async () => {
		const text = await callTool('auth_status')
		expect(text).toContain(`${SELF_HOST}/login?connection_id=conn-42`)
		expect(text).not.toContain('discogs-mcp.com')
	})

	it('server_info points at this deployment', async () => {
		const text = await callTool('server_info')
		expect(text).toContain(`${SELF_HOST}/login?connection_id=conn-42`)
		expect(text).not.toContain('discogs-mcp.com')
	})

	it('authenticated tools point at this deployment when no session exists', async () => {
		const text = await callTool('get_collection_stats')
		expect(text).toContain(`${SELF_HOST}/login?connection_id=conn-42`)
		expect(text).not.toContain('discogs-mcp.com')
	})
})
