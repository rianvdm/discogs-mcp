// ABOUTME: Tests for SmartCache background deletes of expired and stale-version entries.
// ABOUTME: Covers registration with the Worker ExecutionContext so the runtime keeps the isolate alive.
import { describe, it, expect, vi } from 'vitest'
import { SmartCache } from '../../src/utils/cache'

function makeKV(store: Map<string, string>): KVNamespace {
	return {
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
		list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
	} as unknown as KVNamespace
}

function entry(overrides: { expiresAt?: number; version?: string }) {
	return JSON.stringify({
		data: { hello: 'world' },
		timestamp: Date.now() - 1000,
		expiresAt: Date.now() + 60_000,
		version: '1.0.0',
		...overrides,
	})
}

describe('SmartCache background deletes', () => {
	// `get` deletes expired and version-mismatched entries without awaiting the delete.
	// In Workers, a promise that is neither awaited nor handed to ctx.waitUntil() can be
	// cancelled when the handler returns, so the delete must be registered with the
	// ExecutionContext when one is available. https://github.com/rianvdm/discogs-mcp/issues/27

	it('registers the delete of an expired entry with waitUntil', async () => {
		const store = new Map([['cache:stats:user', entry({ expiresAt: Date.now() - 1 })]])
		const kv = makeKV(store)
		const waitUntil = vi.fn()
		const cache = new SmartCache(kv, {}, waitUntil)

		expect(await cache.get('stats', 'user')).toBeNull()

		expect(waitUntil).toHaveBeenCalledTimes(1)
		expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise)
		await waitUntil.mock.calls[0][0]
		expect(kv.delete).toHaveBeenCalledWith('cache:stats:user')
		expect(store.has('cache:stats:user')).toBe(false)
	})

	it('registers the delete of a stale-version entry with waitUntil', async () => {
		const store = new Map([['cache:stats:user', entry({ version: '0.9.0' })]])
		const kv = makeKV(store)
		const waitUntil = vi.fn()
		const cache = new SmartCache(kv, {}, waitUntil)

		expect(await cache.get('stats', 'user')).toBeNull()

		expect(waitUntil).toHaveBeenCalledTimes(1)
		await waitUntil.mock.calls[0][0]
		expect(kv.delete).toHaveBeenCalledWith('cache:stats:user')
	})

	it('still deletes an expired entry when no waitUntil is provided', async () => {
		const store = new Map([['cache:stats:user', entry({ expiresAt: Date.now() - 1 })]])
		const kv = makeKV(store)
		const cache = new SmartCache(kv)

		expect(await cache.get('stats', 'user')).toBeNull()

		await Promise.resolve()
		expect(kv.delete).toHaveBeenCalledWith('cache:stats:user')
	})

	it('does not touch waitUntil for a fresh entry', async () => {
		const store = new Map([['cache:stats:user', entry({})]])
		const waitUntil = vi.fn()
		const cache = new SmartCache(makeKV(store), {}, waitUntil)

		expect(await cache.get('stats', 'user')).toEqual({ hello: 'world' })
		expect(waitUntil).not.toHaveBeenCalled()
	})
})
