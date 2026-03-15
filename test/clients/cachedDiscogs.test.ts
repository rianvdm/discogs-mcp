// test/clients/cachedDiscogs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CachedDiscogsClient } from '../../src/clients/cachedDiscogs'
import { DiscogsClient } from '../../src/clients/discogs'

// Minimal KV mock — only methods actually used by SmartCache
function makeKV(store: Map<string, string> = new Map()): KVNamespace {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
  } as unknown as KVNamespace
}

function makePageResponse(page: number, totalPages: number, totalItems: number) {
  const isLastPage = page === totalPages
  const itemsInLastPage = totalItems % 100 || 100
  const releasesCount = isLastPage ? itemsInLastPage : 100
  const releases = Array.from({ length: releasesCount }, (_, i) => ({ id: page * 100 + i }))
  return {
    pagination: { page, pages: totalPages, per_page: 100, items: totalItems, urls: {} },
    releases,
  }
}

describe('CachedDiscogsClient.getCompleteCollection', () => {
  let client: CachedDiscogsClient
  let mockSearchCollection: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    const kv = makeKV()
    // CachedDiscogsClient constructor: (client: DiscogsClient, kv: KVNamespace)
    // The inner DiscogsClient is irrelevant here — we spy on searchCollection directly.
    client = new CachedDiscogsClient({ setKV: vi.fn() } as unknown as DiscogsClient, kv)
    // Spy on the internal searchCollection so we can control page responses
    mockSearchCollection = vi.fn()
    vi.spyOn(client as never, 'searchCollection').mockImplementation(mockSearchCollection)
  })

  it('returns pagination.items equal to the real Discogs total, not truncated count', async () => {
    // 40 pages = 4000 items, but maxPages default is 50, so all pages are fetched
    const totalItems = 4000
    const totalPages = 40
    mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) => {
      return Promise.resolve(makePageResponse(opts.page, totalPages, totalItems))
    })

    const result = await client.getCompleteCollection('user', 'token', 'secret', 'key', 'consumerSecret')

    expect(result.pagination.items).toBe(4000)
    expect(result.releases).toHaveLength(4000)
    expect(mockSearchCollection).toHaveBeenCalledTimes(40)
  })

  it('reports actual total even when collection exceeds maxPages cap', async () => {
    // 70 pages = 7000 items, exceeds default maxPages=50
    const totalItems = 7000
    const totalPages = 70
    mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) => {
      return Promise.resolve(makePageResponse(opts.page, totalPages, totalItems))
    })

    const result = await client.getCompleteCollection('user', 'token', 'secret', 'key', 'consumerSecret')

    // pagination.items should be the REAL Discogs total (7000), not truncated count (5000)
    expect(result.pagination.items).toBe(7000)
    // Only 50 pages fetched due to maxPages cap (5000 items at 100/page)
    expect(mockSearchCollection).toHaveBeenCalledTimes(50)
  })

  it('logs a warning when collection is truncated', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const totalItems = 6000
    mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) => {
      return Promise.resolve(makePageResponse(opts.page, 60, totalItems))
    })

    await client.getCompleteCollection('user', 'token', 'secret', 'key', 'consumerSecret')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('truncated'))
  })

  it('does NOT log a truncation warning when full collection fits within maxPages', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) => {
      return Promise.resolve(makePageResponse(opts.page, 10, 1000)) // 1000 items, 10 pages
    })

    await client.getCompleteCollection('user', 'token', 'secret', 'key', 'consumerSecret')

    const truncationLogs = consoleSpy.mock.calls.filter(args => String(args[0]).includes('truncated'))
    expect(truncationLogs).toHaveLength(0)
  })
})
