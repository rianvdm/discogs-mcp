// src/rate-limiter/client.ts
import type { RateLimiterRequest, RateLimiterResponse, RateLimiterStub, RequestPriority } from './types'

/**
 * Send a fetch request through the rate limiter Durable Object.
 * Returns a standard Response object so callers don't need to change.
 *
 * `priority` names the caller's lane; omitting it means interactive, which is
 * what every user-facing tool call wants.
 */
export async function rateLimitedFetch(
  stub: RateLimiterStub,
  url: string,
  init: {
    method?: string
    headers?: Record<string, string> | HeadersInit
    body?: string
    priority?: RequestPriority
  },
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
    ...(init.priority ? { priority: init.priority } : {}),
  }

  const doResponse = await stub.fetch(
    new Request('https://do-internal/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )

  const result: RateLimiterResponse = await doResponse.json()

  // Null-body statuses (101/204/205/304) reject any body — even an empty string —
  // when passed to the Response constructor. Discogs returns 204 on successful
  // collection mutations, so we must pass null in those cases.
  const hasNullBodyStatus =
    result.status === 101 || result.status === 204 || result.status === 205 || result.status === 304

  return new Response(hasNullBodyStatus ? null : result.body, {
    status: result.status,
    headers: result.headers,
  })
}
