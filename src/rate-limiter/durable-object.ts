// src/rate-limiter/durable-object.ts
import type { RateLimiterRequest, RateLimiterResponse, BudgetState } from './types'

const MAX_QUEUE_DEPTH = 20
const QUEUE_TIMEOUT_MS = 30_000
const DEFAULT_PAUSE_MS = 60_000
const WINDOW_RESET_MS = 60_000

/** Exported for testing — compute delay based on remaining budget */
export function getDelay(remaining: number): number {
  if (remaining >= 20) return 0
  if (remaining >= 10) return 1000
  if (remaining >= 5) return 3000
  if (remaining >= 1) return 10000
  return -1 // must queue until window resets
}

/** Exported for testing — update budget from Discogs response headers */
export function updateBudgetFromHeaders(
  budget: BudgetState,
  headers: Record<string, string>,
): BudgetState {
  const remaining = headers['x-discogs-ratelimit-remaining']
  const limit = headers['x-discogs-ratelimit']
  return {
    remaining: remaining != null ? parseInt(remaining, 10) : budget.remaining,
    limit: limit != null ? parseInt(limit, 10) : budget.limit,
    lastUpdated: remaining != null ? Date.now() : budget.lastUpdated,
  }
}

/** Exported for testing — check if queue is full */
export function shouldRejectQueue(queueLength: number): boolean {
  return queueLength >= MAX_QUEUE_DEPTH
}

interface QueuedRequest {
  resolve: (response: RateLimiterResponse) => void
  reject: (error: Error) => void
  request: RateLimiterRequest
  enqueuedAt: number
}

export class DiscogsRateLimiter implements DurableObject {
  private state: DurableObjectState
  private budget: BudgetState = { remaining: 60, limit: 60, lastUpdated: 0 }
  private queue: QueuedRequest[] = []
  private processing = false
  private paused = false

  constructor(state: DurableObjectState) {
    this.state = state
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<BudgetState>('budget')
      if (stored) {
        this.budget = stored
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const limiterReq: RateLimiterRequest = await request.json()
    const response = await this.enqueue(limiterReq)
    return new Response(JSON.stringify(response), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async alarm(): Promise<void> {
    this.budget.remaining = this.budget.limit
    this.budget.lastUpdated = Date.now()
    await this.state.storage.put('budget', this.budget)

    if (this.queue.length > 0) {
      this.paused = false
      this.drainQueue()
    }
  }

  private enqueue(request: RateLimiterRequest): Promise<RateLimiterResponse> {
    if (shouldRejectQueue(this.queue.length)) {
      return Promise.resolve({
        status: 503,
        headers: {},
        body: JSON.stringify({ error: 'Rate limiter queue full, retry later' }),
      })
    }

    return new Promise<RateLimiterResponse>((resolve, reject) => {
      const entry: QueuedRequest = {
        resolve,
        reject,
        request,
        enqueuedAt: Date.now(),
      }

      this.queue.push(entry)

      setTimeout(() => {
        const idx = this.queue.indexOf(entry)
        if (idx !== -1) {
          this.queue.splice(idx, 1)
          resolve({
            status: 504,
            headers: {},
            body: JSON.stringify({ error: 'Rate limiter timeout' }),
          })
        }
      }, QUEUE_TIMEOUT_MS)

      if (!this.processing) {
        this.drainQueue()
      }
    })
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      if (this.paused) {
        this.processing = false
        return
      }

      const entry = this.queue[0]
      if (Date.now() - entry.enqueuedAt >= QUEUE_TIMEOUT_MS) {
        this.queue.shift()
        continue
      }

      const delay = getDelay(this.budget.remaining)
      if (delay === -1) {
        await this.scheduleWindowReset()
        this.paused = true
        this.processing = false
        return
      }

      if (delay > 0) {
        await this.sleep(delay)
      }

      this.queue.shift()
      const response = await this.executeRequest(entry.request)

      if (response.status === 429) {
        this.budget.remaining = 0
        await this.state.storage.put('budget', this.budget)

        const retryAfter = response.headers['retry-after']
        const pauseMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : DEFAULT_PAUSE_MS

        this.queue.unshift(entry)

        await this.state.storage.setAlarm(Date.now() + pauseMs)
        this.paused = true
        this.processing = false
        return
      }

      this.budget = updateBudgetFromHeaders(this.budget, response.headers)
      await this.state.storage.put('budget', this.budget)

      await this.scheduleWindowReset()

      entry.resolve(response)
    }

    this.processing = false
  }

  private async executeRequest(req: RateLimiterRequest): Promise<RateLimiterResponse> {
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body ?? undefined,
      })

      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })

      const body = await response.text()

      return { status: response.status, headers, body }
    } catch (error) {
      return {
        status: 502,
        headers: {},
        body: JSON.stringify({
          error: `Rate limiter fetch error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }),
      }
    }
  }

  private async scheduleWindowReset(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + WINDOW_RESET_MS)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
