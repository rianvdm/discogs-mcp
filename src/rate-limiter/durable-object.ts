// src/rate-limiter/durable-object.ts
import type { RateLimiterRequest, RateLimiterResponse, BudgetState } from './types'

const MAX_QUEUE_DEPTH = 20
const QUEUE_TIMEOUT_MS = 90_000
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
  timeoutId?: ReturnType<typeof setTimeout>
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
        const age = Date.now() - stored.lastUpdated
        if (age > WINDOW_RESET_MS) {
          this.budget = { remaining: stored.limit, limit: stored.limit, lastUpdated: Date.now() }
          console.log(`[RL] Restored budget but stale (${Math.round(age / 1000)}s old), reset to ${stored.limit}`)
        } else {
          this.budget = stored
          console.log('[RL] Restored budget from storage:', stored)
        }
      } else {
        console.log('[RL] Cold start, assuming remaining=60')
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    // Debug state endpoint — read-only snapshot, no Discogs call, no body required
    if (new URL(request.url).pathname === '/state') {
      const now = Date.now()
      return new Response(
        JSON.stringify({
          budget: {
            remaining: this.budget.remaining,
            limit: this.budget.limit,
            lastUpdated: this.budget.lastUpdated,
            ageMs: this.budget.lastUpdated > 0 ? now - this.budget.lastUpdated : null,
          },
          queue: {
            depth: this.queue.length,
            processing: this.processing,
            paused: this.paused,
          },
          serverTime: now,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const limiterReq: RateLimiterRequest = await request.json()
    const path = new URL(limiterReq.url).pathname
    console.log(`[RL] Request: ${limiterReq.method} ${path} | budget: ${this.budget.remaining}/${this.budget.limit} | queue: ${this.queue.length}`)
    const response = await this.enqueue(limiterReq)
    return new Response(JSON.stringify(response), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async alarm(): Promise<void> {
    console.log(`[RL] Alarm fired — resetting budget to ${this.budget.limit}, queued: ${this.queue.length}`)
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
      console.warn(`[RL] Queue full (${this.queue.length}), rejecting request`)
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

      entry.timeoutId = setTimeout(() => {
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
        console.warn(`[RL] Budget exhausted (remaining=0), pausing until window reset | queued: ${this.queue.length}`)
        await this.scheduleWindowReset()
        this.paused = true
        this.processing = false
        return
      }

      if (delay > 0) {
        console.log(`[RL] Throttling ${delay}ms (remaining=${this.budget.remaining})`)
        await this.sleep(delay)
      }

      this.queue.shift()
      const response = await this.executeRequest(entry.request)

      if (response.status === 429) {
        const retryAfter = response.headers['retry-after']
        const pauseMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : DEFAULT_PAUSE_MS
        console.warn(`[RL] 429 from Discogs! Pausing ${pauseMs}ms, re-queuing request | queue: ${this.queue.length + 1}`)

        this.budget.remaining = 0
        await this.state.storage.put('budget', this.budget)

        // Cancel the original timeout and give it a fresh window after the pause
        if (entry.timeoutId) clearTimeout(entry.timeoutId)
        entry.enqueuedAt = Date.now() + pauseMs // reset so drainQueue doesn't expire it
        entry.timeoutId = setTimeout(() => {
          const idx = this.queue.indexOf(entry)
          if (idx !== -1) {
            this.queue.splice(idx, 1)
            entry.resolve({
              status: 504,
              headers: {},
              body: JSON.stringify({ error: 'Rate limiter timeout' }),
            })
          }
        }, pauseMs + QUEUE_TIMEOUT_MS)

        this.queue.unshift(entry)

        await this.state.storage.setAlarm(Date.now() + pauseMs)
        this.paused = true
        this.processing = false
        return
      }

      const prevRemaining = this.budget.remaining
      this.budget = updateBudgetFromHeaders(this.budget, response.headers)
      await this.state.storage.put('budget', this.budget)
      if (this.budget.remaining !== prevRemaining) {
        console.log(`[RL] Budget updated: ${prevRemaining} → ${this.budget.remaining}/${this.budget.limit}`)
      }

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
      console.error(`[RL] Fetch error for ${req.url}:`, error instanceof Error ? error.message : error)
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
