// ABOUTME: Checks that auth_status names every registered authenticated tool, and the wantlist tools when signed out.
// ABOUTME: Guards against the hand-written lists in public.ts drifting behind authenticated.ts.
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/server'
import { createMcpServer, type DiscogsSession, type SessionContext } from '../../../src/mcp/server'
import { registerAuthenticatedTools } from '../../../src/mcp/tools/authenticated'

type Handler = (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>

const session: DiscogsSession = { username: 'u', numericId: '12345', accessToken: 'tok', accessTokenSecret: 'sec' }

/** Names passed to registerTool by registerAuthenticatedTools, captured with a stub server. */
function registeredAuthenticatedToolNames(): string[] {
	const names: string[] = []
	const stub = { registerTool: (name: string) => names.push(name) } as unknown as McpServer
	const noSession = async (): Promise<SessionContext> => ({ session: null, baseUrl: 'https://discogs.example.net' })
	registerAuthenticatedTools(stub, env as any, noSession)
	return names
}

async function authStatusText(withSession: DiscogsSession | null): Promise<string> {
	const { server, setContext } = createMcpServer(env as any, 'https://discogs.example.net')
	setContext({ session: withSession, sessionId: 'conn-1' })
	const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools
	const res = await tools['auth_status'].handler({}, {})
	return res.content.map((c) => c.text).join('\n')
}

/** Tool names from the `*Category:* a, b, c` lines under "Available tools", in order. */
function listedToolNames(text: string): string[] {
	const section = text.split('**Available tools:**')[1]?.split('\n---\n')[0]
	if (!section) throw new Error('auth_status response has no "Available tools" section')
	return section
		.split('\n')
		.map((line) => line.match(/^\*[^*]+:\*\s+(.+)$/)?.[1])
		.filter((names): names is string => names !== undefined)
		.flatMap((names) => names.split(',').map((name) => name.trim()))
}

describe('auth_status available tools list', () => {
	it('names each registered authenticated tool exactly once', async () => {
		const registered = registeredAuthenticatedToolNames()
		const listed = listedToolNames(await authStatusText(session))

		expect(registered.length).toBeGreaterThan(0)
		expect([...listed].sort()).toEqual([...registered].sort())
	})

	it('tells an unauthenticated caller that the wantlist tools exist', async () => {
		const text = await authStatusText(null)
		for (const tool of ['get_wantlist', 'add_to_wantlist', 'remove_from_wantlist']) {
			expect(text).toContain(tool)
		}
	})
})
