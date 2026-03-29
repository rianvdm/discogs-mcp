// src/rate-limiter/types.ts

/** Request from Worker to the rate limiter DO */
export interface RateLimiterRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
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
