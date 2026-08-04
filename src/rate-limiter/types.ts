// src/rate-limiter/types.ts

/**
 * Which lane a request belongs to. `interactive` has a caller waiting on the
 * other end — an MCP tool call that abandons the request at 120s — and would
 * rather fail quickly than sit through a retry it cannot afford. `background`
 * is the scheduled collection sync, where nobody is waiting on the answer.
 */
export type RequestPriority = 'interactive' | 'background'

/** Request from Worker to the rate limiter DO */
export interface RateLimiterRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  /** Absent means `interactive` — see priorityOf. */
  priority?: RequestPriority
}

/** Response from the rate limiter DO back to Worker */
export interface RateLimiterResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** Internal budget state persisted in DO storage */
export interface BudgetState {
  remaining: number
  limit: number
  lastUpdated: number
}

/** DO stub interface used by the client wrapper */
export interface RateLimiterStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
}
