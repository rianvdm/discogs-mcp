// src/rate-limiter/durable-object.ts
import type { RateLimiterRequest, RateLimiterResponse, BudgetState } from './types'

const MAX_QUEUE_DEPTH = 20
const QUEUE_TIMEOUT_MS = 90_000
const DEFAULT_PAUSE_MS = 60_000
const WINDOW_RESET_MS = 60_000

/**
 * Per-entry retry cap for 429s. Each queued request is sent to Discogs at most
 * MAX_ATTEMPTS_PER_ENTRY times; on the final 429, the entry resolves with the
 * 429 response (and Retry-After) so the caller can decide what to do, instead
 * of being re-queued indefinitely.
 */
export const MAX_ATTEMPTS_PER_ENTRY = 3

/**
 * Circuit-breaker threshold. Once this many consecutive 429s are observed
 * across all entries, the DO trips for COOLDOWN_MS — incoming requests fail
 * fast with 429 + Retry-After, no Discogs traffic. Resets on first non-429.
 *
 * Why a circuit breaker: when Cloudflare's egress IP gets tarpitted by Discogs,
 * the DO's per-minute retry was actively prolonging the tarpit by re-probing
 * the IP every 60s. Stopping all probes during cooldown lets the IP cool off.
 */
export const TRIP_THRESHOLD = 3

/**
 * How long to stay tripped before allowing a probe through. Discogs's egress-IP
 * penalty typically clears in 15-30 min; 10 min is a deliberate under-pause so
 * we re-trip if needed rather than over-block legitimate traffic.
 */
export const COOLDOWN_MS = 10 * 60_000

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

/** Whether an entry has hit its retry cap and should be failed instead of re-queued. */
export function shouldGiveUpEntry(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS_PER_ENTRY
}

/** Whether sustained-429 streak has tripped the circuit. */
export function shouldTripCircuit(consecutive429s: number): boolean {
  return consecutive429s >= TRIP_THRESHOLD
}

/** Whether the DO is currently in cooldown (tripped). */
export function isInCooldown(trippedUntil: number | null, now: number): boolean {
  return trippedUntil !== null && now < trippedUntil
}

/** Seconds remaining until cooldown ends, rounded up. Never negative. */
export function cooldownRetryAfterSecs(trippedUntil: number, now: number): number {
  return Math.max(0, Math.ceil((trippedUntil - now) / 1000))
}

interface QueuedRequest {
  resolve: (response: RateLimiterResponse) => void
  reject: (error: Error) => void
  request: RateLimiterRequest
  enqueuedAt: number
  /** How many times this entry has been sent to Discogs. */
  attempts: number
  timeoutId?: ReturnType<typeof setTimeout>
}

export class DiscogsRateLimiter implements DurableObject {
  private state: DurableObjectState
  private budget: BudgetState = { remaining: 60, limit: 60, lastUpdated: 0 }
  private queue: QueuedRequest[] = []
  private processing = false
  private paused = false
  /** Consecutive 429s observed across entries. Reset on first non-429. */
  private consecutive429s = 0
  /** Wall-clock ms when cooldown ends; null = not tripped. Persisted. */
  private trippedUntil: number | null = null

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

      const storedStreak = await state.storage.get<number>('consecutive429s')
      if (typeof storedStreak === 'number') this.consecutive429s = storedStreak

      const storedTripped = await state.storage.get<number>('trippedUntil')
      if (typeof storedTripped === 'number') {
        if (Date.now() < storedTripped) {
          this.trippedUntil = storedTripped
          console.warn(`[RL] Restored circuit-breaker cooldown, ${Math.round((storedTripped - Date.now()) / 1000)}s remaining`)
        } else {
          // Stale — clear it. Half-open: keep streak at TRIP_THRESHOLD - 1 so
          // the next 429 trips again immediately.
          await state.storage.delete('trippedUntil')
          this.consecutive429s = Math.min(this.consecutive429s, TRIP_THRESHOLD - 1)
          await state.storage.put('consecutive429s', this.consecutive429s)
        }
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
          circuit: {
            consecutive429s: this.consecutive429s,
            trippedUntil: this.trippedUntil,
            inCooldown: isInCooldown(this.trippedUntil, now),
            cooldownRemainingSecs: this.trippedUntil !== null
              ? cooldownRetryAfterSecs(this.trippedUntil, now)
              : 0,
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
    // Always 200 on the outer DO response — the upstream Discogs status is
    // carried inside the JSON payload. If we used response.status here, a
    // 204 from Discogs would make `new Response(<json>, { status: 204 })`
    // throw because null-body statuses can't have a body.
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async alarm(): Promise<void> {
    if (this.trippedUntil !== null && Date.now() >= this.trippedUntil) {
      // Cooldown elapsed — half-open. Keep streak at TRIP_THRESHOLD - 1 so
      // the very next 429 trips again immediately; reset to 0 only on success.
      console.warn('[RL] Circuit cooldown elapsed, entering half-open state')
      this.trippedUntil = null
      await this.state.storage.delete('trippedUntil')
      this.consecutive429s = TRIP_THRESHOLD - 1
      await this.state.storage.put('consecutive429s', this.consecutive429s)
      this.paused = false
      // Fresh window — let one probe through.
      this.budget.remaining = this.budget.limit
      this.budget.lastUpdated = Date.now()
      await this.state.storage.put('budget', this.budget)
      // No queued requests to drain (they were failed when we tripped); next
      // incoming request will be the probe.
      return
    }

    console.log(`[RL] Alarm fired — resetting budget to ${this.budget.limit}, queued: ${this.queue.length}`)
    this.budget.remaining = this.budget.limit
    this.budget.lastUpdated = Date.now()
    await this.state.storage.put('budget', this.budget)

    if (this.queue.length > 0) {
      this.paused = false
      this.drainQueue()
    }
  }

  /** Resolve every queued entry with 429 + Retry-After during cooldown. */
  private failQueueDuringCooldown(): void {
    if (this.trippedUntil === null) return
    const retryAfter = cooldownRetryAfterSecs(this.trippedUntil, Date.now())
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!
      if (entry.timeoutId) clearTimeout(entry.timeoutId)
      entry.resolve({
        status: 429,
        headers: { 'retry-after': String(retryAfter) },
        body: JSON.stringify({
          error: 'Discogs rate-limit circuit tripped',
          retryAfterSecs: retryAfter,
        }),
      })
    }
  }

  private enqueue(request: RateLimiterRequest): Promise<RateLimiterResponse> {
    if (isInCooldown(this.trippedUntil, Date.now())) {
      const retryAfter = cooldownRetryAfterSecs(this.trippedUntil!, Date.now())
      console.warn(`[RL] Circuit tripped, fast-failing request | retry-after: ${retryAfter}s`)
      return Promise.resolve({
        status: 429,
        headers: { 'retry-after': String(retryAfter) },
        body: JSON.stringify({
          error: 'Discogs rate-limit circuit tripped',
          retryAfterSecs: retryAfter,
        }),
      })
    }

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
        attempts: 0,
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
      entry.attempts += 1
      const response = await this.executeRequest(entry.request)

      if (response.status === 429) {
        this.consecutive429s += 1
        await this.state.storage.put('consecutive429s', this.consecutive429s)

        const retryAfter = response.headers['retry-after']
        const pauseMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : DEFAULT_PAUSE_MS
        this.budget.remaining = 0
        await this.state.storage.put('budget', this.budget)

        if (shouldTripCircuit(this.consecutive429s)) {
          // IP-tarpit territory. Stop probing entirely for COOLDOWN_MS and
          // fail every queued + incoming request fast so callers back off too.
          this.trippedUntil = Date.now() + COOLDOWN_MS
          await this.state.storage.put('trippedUntil', this.trippedUntil)
          console.warn(
            `[RL] Circuit TRIPPED — ${this.consecutive429s} consecutive 429s, ` +
              `cooling down ${COOLDOWN_MS / 1000}s, failing ${this.queue.length + 1} request(s)`,
          )
          // Resolve the current entry with the 429 response (carry Retry-After
          // through). Don't re-queue.
          if (entry.timeoutId) clearTimeout(entry.timeoutId)
          entry.resolve(response)
          // Drain the rest of the queue with synthetic 429s.
          this.failQueueDuringCooldown()
          await this.state.storage.setAlarm(this.trippedUntil)
          this.paused = true
          this.processing = false
          return
        }

        if (shouldGiveUpEntry(entry.attempts)) {
          console.warn(
            `[RL] Entry hit retry cap (${entry.attempts}/${MAX_ATTEMPTS_PER_ENTRY}), surfacing 429 to caller`,
          )
          if (entry.timeoutId) clearTimeout(entry.timeoutId)
          entry.resolve(response)
          // Pause until window reset — if we keep going we'll just 429 again.
          await this.state.storage.setAlarm(Date.now() + pauseMs)
          this.paused = true
          this.processing = false
          return
        }

        console.warn(
          `[RL] 429 from Discogs (attempt ${entry.attempts}/${MAX_ATTEMPTS_PER_ENTRY}, ` +
            `streak ${this.consecutive429s}/${TRIP_THRESHOLD}). Pausing ${pauseMs}ms, re-queuing | queue: ${this.queue.length + 1}`,
        )

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

      // Non-429 response: reset the consecutive-429 streak if we'd been in one.
      if (response.status < 400 && this.consecutive429s > 0) {
        console.log(`[RL] Discogs healthy again, resetting 429 streak (was ${this.consecutive429s})`)
        this.consecutive429s = 0
        await this.state.storage.put('consecutive429s', this.consecutive429s)
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
