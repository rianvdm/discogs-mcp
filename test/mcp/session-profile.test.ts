import { describe, it, expect } from 'vitest'
import { sessionProfile } from '../../src/mcp/session-profile'

describe('sessionProfile', () => {
	it('reads username and numericId straight off the session', () => {
		expect(sessionProfile({ username: 'rianvdm', numericId: '12345' })).toEqual({
			username: 'rianvdm',
			numericId: '12345',
		})
	})

	it('throws a re-auth error rather than returning an empty username', () => {
		// An empty username would silently produce requests to `/users//collection`.
		expect(() => sessionProfile({ username: '', numericId: '12345' })).toThrow(/re-authenticate/i)
	})

	it('is synchronous, so no call site can spend rate-limit budget on it', () => {
		// Regression guard for #45: this used to be an async `/oauth/identity`
		// fetch on the hot path of every authenticated tool.
		const result = sessionProfile({ username: 'rianvdm', numericId: '12345' })
		expect(result).not.toBeInstanceOf(Promise)
	})
})
