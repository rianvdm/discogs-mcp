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

  it('reconstructs a 204 response without throwing (Discogs write success)', async () => {
    // Regression: Discogs returns 204 No Content on successful collection
    // mutations. The DO sends back body="" via response.text(). Constructing
    // `new Response("", { status: 204 })` throws "null body status cannot
    // have a body", which surfaced to users as a "failed" write even though
    // the mutation succeeded. See issue #25.
    const stub = createMockStub({
      status: 204,
      headers: { 'x-discogs-ratelimit-remaining': '59' },
      body: '',
    })

    const response = await rateLimitedFetch(stub, 'https://api.discogs.com/users/x/collection/folders/1/releases/2/instances/3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"folder_id":7}',
    })

    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('labels a request with the caller’s lane', async () => {
    const stub = createMockStub({ status: 200, headers: {}, body: '{}' })

    await rateLimitedFetch(stub, 'https://api.discogs.com/users/x/collection/folders/0/releases', {
      method: 'GET',
      headers: {},
      priority: 'background',
    })

    const callArgs = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const sentBody = JSON.parse(await (callArgs[0] as Request).text())
    expect(sentBody.priority).toBe('background')
  })

  it('leaves the lane unset when the caller does not name one', async () => {
    // The DO defaults an unlabelled request to the interactive lane, so tool
    // call sites that never opt in keep failing fast rather than waiting.
    const stub = createMockStub({ status: 200, headers: {}, body: '{}' })

    await rateLimitedFetch(stub, 'https://api.discogs.com/releases/123', { method: 'GET', headers: {} })

    const callArgs = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const sentBody = JSON.parse(await (callArgs[0] as Request).text())
    expect(sentBody.priority).toBeUndefined()
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
