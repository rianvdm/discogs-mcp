// src/rate-limiter/durable-object.ts
import type { RateLimiterRequest, RateLimiterResponse, BudgetState, RequestPriority } from './types'

const MAX_QUEUE_DEPTH = 20
const QUEUE_TIMEOUT_MS = 90_000
const WINDOW_RESET_MS = 60_000

/**
 * Budget to assume when we have positive evidence Discogs is throttling us —
 * i.e. a 429 in the recent past. `getDelay(PROBE_BUDGET)` throttles the next
 * request instead of firing it immediately, so we test the water rather than
 * jumping back in.
 *
 * Why not use this for every reset: we can't know the real budget until Discogs
 * tells us, but assuming the worst on every idle start would add 10s to the
 * first call of every session. The optimistic reset is only wrong when we
 * already have evidence it's wrong, so that's the only case we change.
 */
export const PROBE_BUDGET = 1

/** First backoff step after a 429 that carries no Retry-After. */
export const BASE_PAUSE_MS = 60_000

/** Ceiling for the exponential backoff. */
export const MAX_PAUSE_MS = 240_000

/**
 * A 429 streak older than this says nothing about whether the egress IP is hot
 * *now*, so it decays to zero on restore rather than being carried forward.
 *
 * Without this, `consecutive429s` persists in DO storage across restarts and
 * deploys and only ever resets on a successful response — so after a bad
 * episode the limiter sits primed indefinitely, tripping the breaker on the
 * next single 429 instead of the nominal three. Observed in prod 2026-08-03.
 */
export const STREAK_DECAY_MS = 10 * 60_000

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

/**
 * Total time an interactive entry may spend in 429 backoff before we surface the
 * 429 instead of retrying again.
 *
 * Deliberately below BASE_PAUSE_MS. Discogs almost never sends Retry-After, so
 * the first pause is normally the full 60s — and the attempt that follows it is
 * already doomed, because 60s + the next 120s step exceeds any bound a waiting
 * caller can afford. Starting that pause buys nothing and costs the caller a
 * minute, so an entry whose only available retry is the exponential one fails
 * now rather than later. A short Retry-After still fits, and still retries.
 */
export const INTERACTIVE_MAX_BACKOFF_MS = 30_000

/**
 * The same bound for the scheduled sync, which has no caller to disappoint and
 * can afford to wait out a hot IP across its full attempt budget.
 */
export const BACKGROUND_MAX_BACKOFF_MS = 90_000

/** Backoff a lane may spend before an entry is failed instead of re-queued. */
export function maxBackoffFor(priority: RequestPriority): number {
  return priority === 'background' ? BACKGROUND_MAX_BACKOFF_MS : INTERACTIVE_MAX_BACKOFF_MS
}

/**
 * Lane of a request. Absent means interactive: every call site predating the
 * lane split is a user-facing tool call, so the safe default is the lane that
 * fails fast rather than the one that waits on nobody's behalf.
 */
export function priorityOf(request: RateLimiterRequest): RequestPriority {
  return request.priority ?? 'interactive'
}

/**
 * Where an incoming entry belongs in the queue. Interactive entries go ahead of
 * every background one and behind their own lane's earlier arrivals, so a user's
 * tool call doesn't wait out a page-by-page collection walk. Background entries
 * take the tail.
 */
export function queueInsertIndex(queued: RequestPriority[], incoming: RequestPriority): number {
  if (incoming === 'background') return queued.length
  const firstBackground = queued.indexOf('background')
  return firstBackground === -1 ? queued.length : firstBackground
}

/**
 * Whether an entry should be failed instead of re-queued — either because it's
 * out of attempts, or because the next backoff would outlast its lane's bound.
 */
export function shouldGiveUpEntry(
  attempts: number,
  plannedBackoffMs = 0,
  priority: RequestPriority = 'interactive',
): boolean {
  return attempts >= MAX_ATTEMPTS_PER_ENTRY || plannedBackoffMs >= maxBackoffFor(priority)
}

/**
 * How long to pause after a 429. Honours Discogs's `Retry-After` when it sends
 * one; otherwise doubles per attempt (60s, 120s, 240s) up to MAX_PAUSE_MS.
 *
 * Discogs rarely sends Retry-After, so the exponential path is the common one.
 * Retrying at a flat 60s into an IP tarpit just harvests another 429 at a fixed
 * rate, which is how a single throttled request used to escalate into a tripped
 * circuit in two minutes flat.
 */
export function getPauseMs(attempts: number, retryAfterHeader?: string): number {
  if (retryAfterHeader) {
    const secs = parseInt(retryAfterHeader, 10)
    if (Number.isFinite(secs) && secs > 0) return secs * 1000
  }
  return Math.min(BASE_PAUSE_MS * 2 ** Math.max(0, attempts - 1), MAX_PAUSE_MS)
}

/**
 * Whether a 429 should count toward the circuit-breaker streak.
 *
 * Only an entry's *first* 429 counts. The breaker exists to detect a tarpit
 * affecting traffic broadly; one unlucky request retrying itself is not
 * evidence of that, and counting each attempt meant a single request could trip
 * a global 10-minute breaker entirely on its own.
 */
export function countsTowardStreak(attempts: number): boolean {
  return attempts <= 1
}

/** Streak value to restore, discarding one that's too old to mean anything. */
export function decayStreak(streak: number, updatedAt: number, now: number): number {
  return now - updatedAt > STREAK_DECAY_MS ? 0 : streak
}

/**
 * Budget to assume when a window-reset alarm fires or the DO cold-starts with
 * stale state. A recent 429 means assume a single throttled probe; otherwise
 * the window genuinely has reset and full speed is correct.
 */
export function budgetAfterReset(limit: number, consecutive429s: number): number {
  return consecutive429s > 0 ? PROBE_BUDGET : limit
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
  /** Lane this entry queues and backs off in. */
  priority: RequestPriority
  /** How many times this entry has been sent to Discogs. */
  attempts: number
  /** Cumulative time this entry has spent waiting out 429 backoff. */
  backoffMs: number
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
      // Restore the streak first: it decides whether a stale budget should be
      // restored optimistically or as a single throttled probe.
      const storedStreak = await state.storage.get<number>('consecutive429s')
      if (typeof storedStreak === 'number') {
        const streakUpdatedAt = (await state.storage.get<number>('streakUpdatedAt')) ?? 0
        this.consecutive429s = decayStreak(storedStreak, streakUpdatedAt, Date.now())
        if (this.consecutive429s !== storedStreak) {
          console.log(`[RL] Discarded stale 429 streak of ${storedStreak} (${Math.round((Date.now() - streakUpdatedAt) / 1000)}s old)`)
          await state.storage.put('consecutive429s', this.consecutive429s)
          await state.storage.put('streakUpdatedAt', Date.now())
        }
      }

      const stored = await state.storage.get<BudgetState>('budget')
      if (stored) {
        const age = Date.now() - stored.lastUpdated
        if (age > WINDOW_RESET_MS) {
          const remaining = budgetAfterReset(stored.limit, this.consecutive429s)
          this.budget = { remaining, limit: stored.limit, lastUpdated: Date.now() }
          console.log(`[RL] Restored budget but stale (${Math.round(age / 1000)}s old), reset to ${remaining}`)
        } else {
          this.budget = stored
          console.log('[RL] Restored budget from storage:', stored)
        }
      } else {
        console.log('[RL] Cold start, assuming remaining=60')
      }

      const storedTripped = await state.storage.get<number>('trippedUntil')
      if (typeof storedTripped === 'number') {
        if (Date.now() < storedTripped) {
          this.trippedUntil = storedTripped
          console.warn(`[RL] Restored circuit-breaker cooldown, ${Math.round((storedTripped - Date.now()) / 1000)}s remaining`)
        } else {
          // Stale — clear it. Half-open: keep streak at TRIP_THRESHOLD - 1 so
          // the next 429 trips again immediately. The probe that tests it is
          // throttled via PROBE_BUDGET, so this is a considered retry rather
          // than an instant re-trip.
          await state.storage.delete('trippedUntil')
          await this.setStreak(Math.min(this.consecutive429s, TRIP_THRESHOLD - 1))
        }
      }
    })
  }

  /**
   * Set and persist the 429 streak alongside the timestamp that lets a later
   * cold start decide whether it's still meaningful (see decayStreak).
   */
  private async setStreak(value: number): Promise<void> {
    this.consecutive429s = value
    await this.state.storage.put('consecutive429s', value)
    await this.state.storage.put('streakUpdatedAt', Date.now())
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
            streakUpdatedAt: (await this.state.storage.get<number>('streakUpdatedAt')) ?? null,
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
    console.log(
      `[RL] Request: ${limiterReq.method} ${path} | lane: ${priorityOf(limiterReq)} | budget: ${this.budget.remaining}/${this.budget.limit} | queue: ${this.queue.length}`,
    )
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
      await this.setStreak(TRIP_THRESHOLD - 1)
      this.paused = false
      // Let exactly one *throttled* probe through. Resetting to `limit` here
      // would fire it instantly (getDelay(limit) === 0) straight back into the
      // tarpit we just spent 10 minutes waiting out.
      this.budget.remaining = PROBE_BUDGET
      this.budget.lastUpdated = Date.now()
      await this.state.storage.put('budget', this.budget)
      // No queued requests to drain (they were failed when we tripped); next
      // incoming request will be the probe.
      return
    }

    const reset = budgetAfterReset(this.budget.limit, this.consecutive429s)
    console.log(`[RL] Alarm fired — resetting budget to ${reset}, queued: ${this.queue.length}`)
    this.budget.remaining = reset
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

  /** Place an entry in its lane's position — see queueInsertIndex. */
  private insertIntoQueue(entry: QueuedRequest): void {
    const index = queueInsertIndex(
      this.queue.map((queued) => queued.priority),
      entry.priority,
    )
    this.queue.splice(index, 0, entry)
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
        priority: priorityOf(request),
        attempts: 0,
        backoffMs: 0,
      }

      this.insertIntoQueue(entry)

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
        // Only the entry's first 429 counts toward the breaker — see
        // countsTowardStreak. Its own retries are not independent evidence.
        if (countsTowardStreak(entry.attempts)) {
          await this.setStreak(this.consecutive429s + 1)
        }

        const pauseMs = getPauseMs(entry.attempts, response.headers['retry-after'])
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

        if (shouldGiveUpEntry(entry.attempts, entry.backoffMs + pauseMs, entry.priority)) {
          console.warn(
            `[RL] Giving up on ${entry.priority} entry (attempt ${entry.attempts}/${MAX_ATTEMPTS_PER_ENTRY}, ` +
              `${entry.backoffMs + pauseMs}ms of backoff exceeds the ${maxBackoffFor(entry.priority)}ms lane bound), surfacing 429`,
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
        entry.backoffMs += pauseMs
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

        // Back into its lane's position rather than the head: a re-queued sync
        // page must not jump ahead of a tool call that arrived during its pause.
        this.insertIntoQueue(entry)

        await this.state.storage.setAlarm(Date.now() + pauseMs)
        this.paused = true
        this.processing = false
        return
      }

      // Non-429 response: reset the consecutive-429 streak if we'd been in one.
      if (response.status < 400 && this.consecutive429s > 0) {
        console.log(`[RL] Discogs healthy again, resetting 429 streak (was ${this.consecutive429s})`)
        await this.setStreak(0)
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
