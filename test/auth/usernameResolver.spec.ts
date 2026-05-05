// ABOUTME: Unit tests for the Discogs username → numeric ID resolver.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseUsernameList,
  resolveUsernamesToIds,
  _resetHotCacheForTests,
} from '../../src/auth/usernameResolver'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeKv() {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value)
    }),
    _store: store,
  } as unknown as KVNamespace & {
    _store: Map<string, string>
    get: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  mockFetch.mockReset()
  _resetHotCacheForTests()
})

describe('parseUsernameList', () => {
  it('returns [] for undefined / empty / whitespace', () => {
    expect(parseUsernameList(undefined)).toEqual([])
    expect(parseUsernameList('')).toEqual([])
    expect(parseUsernameList('   ')).toEqual([])
  })

  it('splits on commas and trims', () => {
    expect(parseUsernameList('a,b,c')).toEqual(['a', 'b', 'c'])
    expect(parseUsernameList(' a , b , c ')).toEqual(['a', 'b', 'c'])
  })

  it('lowercases', () => {
    expect(parseUsernameList('JHuggart,RianVDM')).toEqual(['jhuggart', 'rianvdm'])
  })

  it('drops empty entries (e.g. trailing commas)', () => {
    expect(parseUsernameList('a,,b,')).toEqual(['a', 'b'])
  })
})

describe('resolveUsernamesToIds', () => {
  it('returns [] for an empty input list without touching KV or fetch', async () => {
    const kv = makeKv()
    expect(await resolveUsernamesToIds([], kv)).toEqual([])
    expect(kv.get).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches on cache miss, populates KV with 7-day TTL, returns numeric ID string', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 2579319, username: 'elezea-records' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const kv = makeKv()
    const result = await resolveUsernamesToIds(['elezea-records'], kv)
    expect(result).toEqual(['2579319'])

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.discogs.com/users/elezea-records')
    expect(mockFetch.mock.calls[0][1].headers['User-Agent']).toBe('discogs-mcp/1.0.0')

    expect(kv.put).toHaveBeenCalledWith(
      'username-id:elezea-records',
      '2579319',
      { expirationTtl: 7 * 24 * 60 * 60 },
    )
  })

  it('hits the hot cache on the second call', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 111, username: 'a' }), { status: 200 }),
    )
    const kv = makeKv()
    await resolveUsernamesToIds(['a'], kv)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Second call: hot cache hit; no fetch, no KV access
    const kv2 = makeKv()
    const result = await resolveUsernamesToIds(['a'], kv2)
    expect(result).toEqual(['111'])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(kv2.get).not.toHaveBeenCalled()
  })

  it('hits the KV cache (no fetch) when hot cache is cold', async () => {
    const kv = makeKv()
    await kv.put('username-id:rianvdm', '12345')
    _resetHotCacheForTests()

    const result = await resolveUsernamesToIds(['rianvdm'], kv)
    expect(result).toEqual(['12345'])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('drops a username silently on 404 and does not cache the failure', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
    const kv = makeKv()
    const result = await resolveUsernamesToIds(['nope'], kv)
    expect(result).toEqual([])
    expect(kv.put).not.toHaveBeenCalled()

    // A subsequent call retries (no negative caching)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 7, username: 'nope' }), { status: 200 }),
    )
    const result2 = await resolveUsernamesToIds(['nope'], kv)
    expect(result2).toEqual(['7'])
  })

  it('drops a username silently on a network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'))
    const kv = makeKv()
    const result = await resolveUsernamesToIds(['boom'], kv)
    expect(result).toEqual([])
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('resolves multiple usernames in parallel and preserves successes when one fails', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/users/a')) {
        return new Response(JSON.stringify({ id: 1, username: 'a' }), { status: 200 })
      }
      if (url.endsWith('/users/b')) {
        return new Response('Not Found', { status: 404 })
      }
      if (url.endsWith('/users/c')) {
        return new Response(JSON.stringify({ id: 3, username: 'c' }), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    const kv = makeKv()
    const result = await resolveUsernamesToIds(['a', 'b', 'c'], kv)
    expect(result.sort()).toEqual(['1', '3'])
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('treats KV read errors as a cache miss and proceeds to fetch', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 9, username: 'x' }), { status: 200 }),
    )
    const failingKv = {
      get: vi.fn().mockRejectedValue(new Error('kv unavailable')),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace
    const result = await resolveUsernamesToIds(['x'], failingKv)
    expect(result).toEqual(['9'])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
