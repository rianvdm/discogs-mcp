import { describe, it, expect, vi } from 'vitest'
import { registerAuthenticatedTools } from '../../../src/mcp/tools/authenticated'

describe('wantlist tool registration', () => {
	it('registers get_wantlist, add_to_wantlist, and remove_from_wantlist', () => {
		const registered: string[] = []
		const server = {
			tool: vi.fn((name: string) => {
				registered.push(name)
			}),
			prompt: vi.fn(),
			resource: vi.fn(),
		} as any
		const env = { DISCOGS_CONSUMER_KEY: 'k', DISCOGS_CONSUMER_SECRET: 's' } as any
		const getSessionContext = async () => ({ session: null, connectionId: undefined }) as any

		registerAuthenticatedTools(server, env, getSessionContext)

		expect(registered).toContain('get_wantlist')
		expect(registered).toContain('add_to_wantlist')
		expect(registered).toContain('remove_from_wantlist')
	})
})
