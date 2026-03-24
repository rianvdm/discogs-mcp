import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { discogsClient } from '../../src/clients/discogs'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const auth = {
	username: 'testuser',
	accessToken: 'test-token',
	accessTokenSecret: 'test-secret',
	consumerKey: 'test-key',
	consumerSecret: 'test-secret-key',
}

function mockOk(body: unknown) {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
	})
}

function mock204() {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		status: 204,
		json: () => Promise.resolve({}),
	})
}

describe('Discogs Client — Collection Write Operations', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	describe('listFolders', () => {
		it('should return folders array', async () => {
			const folders = [
				{ id: 0, name: 'All', count: 100, resource_url: 'https://api.discogs.com/users/testuser/collection/folders/0' },
				{ id: 1, name: 'Uncategorized', count: 80, resource_url: 'https://api.discogs.com/users/testuser/collection/folders/1' },
				{ id: 2, name: 'Favorites', count: 20, resource_url: 'https://api.discogs.com/users/testuser/collection/folders/2' },
			]
			mockOk({ folders })

			const result = await discogsClient.listFolders(
				auth.username,
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			expect(result).toHaveLength(3)
			expect(result[0].name).toBe('All')
			expect(result[2].name).toBe('Favorites')
		})

		it('should wrap errors with descriptive message', async () => {
			// Use a non-retriable error to avoid retry delays
			mockFetch.mockRejectedValueOnce(new Error('Forbidden'))

			await expect(
				discogsClient.listFolders(auth.username, auth.accessToken, auth.accessTokenSecret, auth.consumerKey, auth.consumerSecret),
			).rejects.toThrow('Failed to list folders')
		})
	})

	describe('createFolder', () => {
		it('should create folder and return it', async () => {
			const folder = { id: 3, name: 'New Arrivals', count: 0, resource_url: 'https://api.discogs.com/users/testuser/collection/folders/3' }
			mockOk(folder)

			const result = await discogsClient.createFolder(
				auth.username,
				'New Arrivals',
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			expect(result.id).toBe(3)
			expect(result.name).toBe('New Arrivals')
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/users/testuser/collection/folders'),
				expect.objectContaining({ method: 'POST' }),
			)
		})

		it('should send name in request body', async () => {
			mockOk({ id: 3, name: 'Test', count: 0 })

			await discogsClient.createFolder(
				auth.username,
				'Test',
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			const callArgs = mockFetch.mock.calls[0]
			expect(JSON.parse(callArgs[1].body)).toEqual({ name: 'Test' })
		})
	})

	describe('editFolder', () => {
		it('should rename folder and return updated folder', async () => {
			const folder = { id: 2, name: 'Renamed', count: 10, resource_url: '' }
			mockOk(folder)

			const result = await discogsClient.editFolder(
				auth.username,
				2,
				'Renamed',
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			expect(result.name).toBe('Renamed')
			expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/collection/folders/2'), expect.objectContaining({ method: 'POST' }))
		})
	})

	describe('deleteFolder', () => {
		it('should send DELETE request', async () => {
			mock204()

			await discogsClient.deleteFolder(auth.username, 2, auth.accessToken, auth.accessTokenSecret, auth.consumerKey, auth.consumerSecret)

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/collection/folders/2'),
				expect.objectContaining({ method: 'DELETE' }),
			)
		})
	})

	describe('addToFolder', () => {
		it('should return instance_id on success', async () => {
			mockOk({ instance_id: 42, resource_url: 'https://api.discogs.com/...' })

			const result = await discogsClient.addToFolder(
				auth.username,
				1,
				12345,
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			expect(result.instance_id).toBe(42)
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/folders/1/releases/12345'),
				expect.objectContaining({ method: 'POST' }),
			)
		})
	})

	describe('removeFromFolder', () => {
		it('should send DELETE with correct URL path', async () => {
			mock204()

			await discogsClient.removeFromFolder(
				auth.username,
				1,
				12345,
				99,
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/folders/1/releases/12345/instances/99'),
				expect.objectContaining({ method: 'DELETE' }),
			)
		})
	})

	describe('editInstance', () => {
		it('should send rating change', async () => {
			mock204()

			await discogsClient.editInstance(
				auth.username,
				1,
				12345,
				99,
				{ rating: 5 },
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			const callArgs = mockFetch.mock.calls[0]
			expect(JSON.parse(callArgs[1].body)).toEqual({ rating: 5 })
			expect(callArgs[1].method).toBe('POST')
		})

		it('should send folder move', async () => {
			mock204()

			await discogsClient.editInstance(
				auth.username,
				1,
				12345,
				99,
				{ folder_id: 3 },
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			const callArgs = mockFetch.mock.calls[0]
			expect(JSON.parse(callArgs[1].body)).toEqual({ folder_id: 3 })
		})
	})

	describe('listCustomFields', () => {
		it('should return fields array', async () => {
			const fields = [
				{ id: 1, name: 'Notes', type: 'textarea', public: true, position: 1, lines: 3 },
				{ id: 2, name: 'Condition', type: 'dropdown', public: false, position: 2, options: ['Mint', 'Near Mint', 'Good'] },
			]
			mockOk({ fields })

			const result = await discogsClient.listCustomFields(
				auth.username,
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			expect(result).toHaveLength(2)
			expect(result[0].name).toBe('Notes')
			expect(result[1].options).toEqual(['Mint', 'Near Mint', 'Good'])
		})
	})

	describe('editCustomFieldValue', () => {
		it('should send value in request body', async () => {
			mock204()

			await discogsClient.editCustomFieldValue(
				auth.username,
				1,
				12345,
				99,
				2,
				'Near Mint',
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			)

			const callArgs = mockFetch.mock.calls[0]
			expect(callArgs[0]).toContain('/instances/99/fields/2')
			expect(JSON.parse(callArgs[1].body)).toEqual({ value: 'Near Mint' })
			expect(callArgs[1].method).toBe('POST')
		})
	})
})

describe('Discogs Client — 429 rate limit handling', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.resetAllMocks()
		mockFetch.mockRejectedValue(new Error('429 Too Many Requests'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	async function expectRateLimitError(promise: Promise<unknown>) {
		const result = promise.catch((e: Error) => e)
		await vi.runAllTimersAsync()
		const error = await result
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toContain('rate limit')
	}

	it('listFolders throws rate limit error', async () => {
		await expectRateLimitError(
			discogsClient.listFolders(auth.username, auth.accessToken, auth.accessTokenSecret, auth.consumerKey, auth.consumerSecret),
		)
	})

	it('createFolder throws rate limit error', async () => {
		await expectRateLimitError(
			discogsClient.createFolder(auth.username, 'Test', auth.accessToken, auth.accessTokenSecret, auth.consumerKey, auth.consumerSecret),
		)
	})

	it('deleteFolder throws rate limit error', async () => {
		await expectRateLimitError(
			discogsClient.deleteFolder(auth.username, 2, auth.accessToken, auth.accessTokenSecret, auth.consumerKey, auth.consumerSecret),
		)
	})

	it('addToFolder throws rate limit error', async () => {
		await expectRateLimitError(
			discogsClient.addToFolder(auth.username, 1, 12345, auth.accessToken, auth.accessTokenSecret, auth.consumerKey, auth.consumerSecret),
		)
	})

	it('removeFromFolder throws rate limit error', async () => {
		await expectRateLimitError(
			discogsClient.removeFromFolder(
				auth.username,
				1,
				12345,
				99,
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			),
		)
	})

	it('editInstance throws rate limit error', async () => {
		await expectRateLimitError(
			discogsClient.editInstance(
				auth.username,
				1,
				12345,
				99,
				{ rating: 3 },
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			),
		)
	})

	it('editCustomFieldValue throws rate limit error', async () => {
		await expectRateLimitError(
			discogsClient.editCustomFieldValue(
				auth.username,
				1,
				12345,
				99,
				2,
				'test',
				auth.accessToken,
				auth.accessTokenSecret,
				auth.consumerKey,
				auth.consumerSecret,
			),
		)
	})
})
