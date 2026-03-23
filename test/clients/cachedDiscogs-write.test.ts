import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CachedDiscogsClient } from '../../src/clients/cachedDiscogs'
import { DiscogsClient } from '../../src/clients/discogs'

// Minimal KV mock
function makeKV(): KVNamespace {
	const store = new Map<string, string>()
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

// Stub DiscogsClient with mock methods for all write operations
function makeMockClient() {
	return {
		setKV: vi.fn(),
		listFolders: vi.fn(async () => [{ id: 0, name: 'All', count: 10, resource_url: '' }]),
		createFolder: vi.fn(async () => ({ id: 3, name: 'New', count: 0, resource_url: '' })),
		editFolder: vi.fn(async () => ({ id: 3, name: 'Renamed', count: 0, resource_url: '' })),
		deleteFolder: vi.fn(async () => undefined),
		addToFolder: vi.fn(async () => ({ instance_id: 42, resource_url: '' })),
		removeFromFolder: vi.fn(async () => undefined),
		editInstance: vi.fn(async () => undefined),
		listCustomFields: vi.fn(async () => [{ id: 1, name: 'Notes', type: 'textarea', public: true, position: 1 }]),
		editCustomFieldValue: vi.fn(async () => undefined),
	} as unknown as DiscogsClient
}

describe('CachedDiscogsClient — write operations & cache invalidation', () => {
	let cached: CachedDiscogsClient
	let mockClient: DiscogsClient
	let invalidateSpy: ReturnType<typeof vi.spyOn>

	const a = ['token', 'secret', 'key', 'csecret'] as const

	beforeEach(() => {
		vi.clearAllMocks()
		const kv = makeKV()
		mockClient = makeMockClient()
		cached = new CachedDiscogsClient(mockClient, kv)
		invalidateSpy = vi.spyOn(cached, 'invalidateUserCache' as never).mockResolvedValue(undefined as never)
	})

	describe('read-only operations (no cache invalidation)', () => {
		it('listFolders passes through without invalidating cache', async () => {
			await cached.listFolders('user', ...a)

			expect((mockClient as any).listFolders).toHaveBeenCalledOnce()
			expect(invalidateSpy).not.toHaveBeenCalled()
		})

		it('listCustomFields passes through without invalidating cache', async () => {
			await cached.listCustomFields('user', ...a)

			expect((mockClient as any).listCustomFields).toHaveBeenCalledOnce()
			expect(invalidateSpy).not.toHaveBeenCalled()
		})
	})

	describe('write operations (invalidate user cache)', () => {
		it('createFolder invalidates user cache', async () => {
			const result = await cached.createFolder('user', 'New', ...a)

			expect(result.name).toBe('New')
			expect(invalidateSpy).toHaveBeenCalledWith('user')
		})

		it('editFolder invalidates user cache', async () => {
			await cached.editFolder('user', 3, 'Renamed', ...a)

			expect(invalidateSpy).toHaveBeenCalledWith('user')
		})

		it('deleteFolder invalidates user cache', async () => {
			await cached.deleteFolder('user', 3, ...a)

			expect(invalidateSpy).toHaveBeenCalledWith('user')
		})

		it('addToFolder invalidates user cache', async () => {
			const result = await cached.addToFolder('user', 1, 12345, ...a)

			expect(result.instance_id).toBe(42)
			expect(invalidateSpy).toHaveBeenCalledWith('user')
		})

		it('removeFromFolder invalidates user cache', async () => {
			await cached.removeFromFolder('user', 1, 12345, 99, ...a)

			expect(invalidateSpy).toHaveBeenCalledWith('user')
		})

		it('editInstance invalidates user cache', async () => {
			await cached.editInstance('user', 1, 12345, 99, { rating: 5 }, ...a)

			expect(invalidateSpy).toHaveBeenCalledWith('user')
		})
	})

	describe('editCustomFieldValue (no cache invalidation)', () => {
		it('does NOT invalidate cache — custom fields do not affect collection structure', async () => {
			await cached.editCustomFieldValue('user', 1, 12345, 99, 2, 'Near Mint', ...a)

			expect((mockClient as any).editCustomFieldValue).toHaveBeenCalledOnce()
			expect(invalidateSpy).not.toHaveBeenCalled()
		})
	})
})
