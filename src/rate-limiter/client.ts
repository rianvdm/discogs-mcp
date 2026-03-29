// src/rate-limiter/client.ts
import type { RateLimiterRequest, RateLimiterResponse, RateLimiterStub } from './types'

/**
 * Send a fetch request through the rate limiter Durable Object.
 * Returns a standard Response object so callers don't need to change.
 */
export async function rateLimitedFetch(
  stub: RateLimiterStub,
  url: string,
  init: { method?: string; headers?: Record<string, string> | HeadersInit; body?: string },
): Promise<Response> {
  // Normalize headers to a plain object
  const headers: Record<string, string> = {}
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value
      })
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value
      }
    } else {
      Object.assign(headers, init.headers)
    }
  }

  const payload: RateLimiterRequest = {
    url,
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  }

  const doResponse = await stub.fetch(
    new Request('https://do-internal/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )

  const result: RateLimiterResponse = await doResponse.json()

  // Reconstruct a standard Response from the DO's response
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  })
}
