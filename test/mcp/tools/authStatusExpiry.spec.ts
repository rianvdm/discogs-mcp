import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createMcpServer, type DiscogsSession } from '../../../src/mcp/server'

type Handler = (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>

async function authStatus(session: DiscogsSession): Promise<string> {
	const { server, setContext } = createMcpServer(env as any, 'https://discogs.example.net')
	setContext({ session, sessionId: 'conn-1' })
	const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools
	const res = await tools['auth_status'].handler({}, {})
	return res.content.map((c) => c.text).join('\n')
}

const base: DiscogsSession = { username: 'u', numericId: '12345', accessToken: 'tok', accessTokenSecret: 'sec' }

describe('auth_status session expiry', () => {
	it('reports the real expiry when the session carries one', async () => {
		const expiresAt = Date.parse('2026-08-30T12:00:00.000Z')
		const text = await authStatus({ ...base, expiresAt })
		expect(text).toContain('Session expires: 2026-08-30T12:00:00.000Z')
	})

	it('omits the expiry line rather than printing the epoch when none is known', async () => {
		const text = await authStatus(base)
		expect(text).not.toContain('Session expires')
		expect(text).not.toContain('1970-01-01')
	})
})
