// test/rate-limiter/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rateLimitedFetch } from '../../src/rate-limiter/client'
import type { RateLimiterResponse, RateLimiterStub } from '../../src/rate-limiter/types'

function createMockStub(response: RateLimiterResponse): RateLimiterStub {
  return {
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  }
}

describe('rateLimitedFetch', () => {
  it('sends request to DO and returns a Response', async () => {
    const stub = createMockStub({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"username":"testuser"}',
    })

    const response = await rateLimitedFetch(stub, 'https://api.discogs.com/users/testuser', {
      method: 'GET',
      headers: { Authorization: 'OAuth ...', 'User-Agent': 'discogs-mcp/1.0.0' },
    })

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.username).toBe('testuser')

    expect(stub.fetch).toHaveBeenCalledOnce()
    const callArgs = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const sentRequest = callArgs[0] as Request
    const sentBody = JSON.parse(await sentRequest.text())
    expect(sentBody.url).toBe('https://api.discogs.com/users/testuser')
    expect(sentBody.method).toBe('GET')
  })

  it('returns error response when DO returns 503', async () => {
    const stub = createMockStub({
      status: 503,
      headers: {},
      body: '{"error":"Rate limiter queue full, retry later"}',
    })

    const response = await rateLimitedFetch(stub, 'https://api.discogs.com/releases/123', {
      method: 'GET',
      headers: {},
    })

    expect(response.status).toBe(503)
  })

  it('passes POST body through to the DO', async () => {
    const stub = createMockStub({
      status: 200,
      headers: {},
      body: '{}',
    })

    await rateLimitedFetch(stub, 'https://api.discogs.com/some/endpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"rating":5}',
    })

    const callArgs = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const sentBody = JSON.parse(await (callArgs[0] as Request).text())
    expect(sentBody.method).toBe('POST')
    expect(sentBody.body).toBe('{"rating":5}')
  })
})
