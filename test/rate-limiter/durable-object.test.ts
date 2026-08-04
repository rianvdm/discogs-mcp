// test/rate-limiter/durable-object.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  getDelay,
  updateBudgetFromHeaders,
  shouldRejectQueue,
  shouldGiveUpEntry,
  shouldTripCircuit,
  isInCooldown,
  cooldownRetryAfterSecs,
  getPauseMs,
  countsTowardStreak,
  decayStreak,
  budgetAfterReset,
  maxBackoffFor,
  priorityOf,
  queueInsertIndex,
  MAX_ATTEMPTS_PER_ENTRY,
  INTERACTIVE_MAX_BACKOFF_MS,
  BACKGROUND_MAX_BACKOFF_MS,
  TRIP_THRESHOLD,
  PROBE_BUDGET,
  BASE_PAUSE_MS,
  MAX_PAUSE_MS,
  STREAK_DECAY_MS,
} from '../../src/rate-limiter/durable-object'
import type { BudgetState } from '../../src/rate-limiter/types'

describe('getDelay', () => {
  it('returns 0 when remaining >= 20', () => {
    expect(getDelay(20)).toBe(0)
    expect(getDelay(60)).toBe(0)
  })

  it('returns 1000 when remaining 10-19', () => {
    expect(getDelay(10)).toBe(1000)
    expect(getDelay(19)).toBe(1000)
  })

  it('returns 3000 when remaining 5-9', () => {
    expect(getDelay(5)).toBe(3000)
    expect(getDelay(9)).toBe(3000)
  })

  it('returns 10000 when remaining 1-4', () => {
    expect(getDelay(1)).toBe(10000)
    expect(getDelay(4)).toBe(10000)
  })

  it('returns -1 (must queue) when remaining is 0', () => {
    expect(getDelay(0)).toBe(-1)
  })
})

describe('updateBudgetFromHeaders', () => {
  it('updates remaining and limit from headers', () => {
    const headers: Record<string, string> = {
      'x-discogs-ratelimit': '60',
      'x-discogs-ratelimit-remaining': '42',
    }
    const budget: BudgetState = { remaining: 60, limit: 60, lastUpdated: 0 }
    const updated = updateBudgetFromHeaders(budget, headers)
    expect(updated.remaining).toBe(42)
    expect(updated.limit).toBe(60)
    expect(updated.lastUpdated).toBeGreaterThan(0)
  })

  it('preserves existing state when headers are missing', () => {
    const budget: BudgetState = { remaining: 30, limit: 60, lastUpdated: 1000 }
    const updated = updateBudgetFromHeaders(budget, {})
    expect(updated.remaining).toBe(30)
    expect(updated.limit).toBe(60)
  })
})

describe('shouldRejectQueue', () => {
  it('returns false when queue is under max depth', () => {
    expect(shouldRejectQueue(19)).toBe(false)
  })

  it('returns true when queue is at max depth', () => {
    expect(shouldRejectQueue(20)).toBe(true)
  })
})

describe('shouldGiveUpEntry', () => {
  it('keeps retrying below the cap', () => {
    for (let n = 0; n < MAX_ATTEMPTS_PER_ENTRY; n++) {
      expect(shouldGiveUpEntry(n)).toBe(false)
    }
  })

  it('gives up at and beyond the cap', () => {
    expect(shouldGiveUpEntry(MAX_ATTEMPTS_PER_ENTRY)).toBe(true)
    expect(shouldGiveUpEntry(MAX_ATTEMPTS_PER_ENTRY + 5)).toBe(true)
  })

  it('gives up once the planned backoff would outlast the lane’s bound', () => {
    expect(shouldGiveUpEntry(1, BACKGROUND_MAX_BACKOFF_MS - 1, 'background')).toBe(false)
    expect(shouldGiveUpEntry(1, BACKGROUND_MAX_BACKOFF_MS, 'background')).toBe(true)
  })

  it('surfaces the 429 within the caller’s window on the real backoff schedule', () => {
    // Replay of the 2026-08-03 incident. Without the backoff bound, attempt 3
    // fired at t=200s — long after the MCP tool call had been abandoned.
    let backoff = 0
    let gaveUpAt: number | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ENTRY; attempt++) {
      const pause = getPauseMs(attempt)
      if (shouldGiveUpEntry(attempt, backoff + pause, 'background')) {
        gaveUpAt = backoff
        break
      }
      backoff += pause
    }
    expect(gaveUpAt).not.toBeNull()
    expect(gaveUpAt!).toBeLessThanOrEqual(BACKGROUND_MAX_BACKOFF_MS)
  })

  it('spends no pause on a retry an interactive caller cannot afford', () => {
    // Replay of the 2026-08-04 starvation. The old single bound (90s) let
    // attempt 1 start a 60s pause, then failed the entry on attempt 2 because
    // 60s + 120s exceeded it — so the caller waited ~80s for a 429 that was
    // already decided. Fail on the first 429 instead.
    expect(shouldGiveUpEntry(1, getPauseMs(1), 'interactive')).toBe(true)
  })

  it('still retries an interactive call when Discogs asks for a short wait', () => {
    // Retry-After is rare from Discogs, but when it arrives and it is short the
    // retry fits comfortably inside the caller's window and is worth making.
    expect(shouldGiveUpEntry(1, getPauseMs(1, '5'), 'interactive')).toBe(false)
  })

  it('lets a background entry use its full attempt budget where interactive would not', () => {
    const plannedBackoff = getPauseMs(1)
    expect(shouldGiveUpEntry(1, plannedBackoff, 'background')).toBe(false)
    expect(shouldGiveUpEntry(1, plannedBackoff, 'interactive')).toBe(true)
  })

  it('defaults to the interactive lane when no priority is given', () => {
    expect(shouldGiveUpEntry(1, getPauseMs(1))).toBe(true)
  })
})

describe('maxBackoffFor', () => {
  it('gives an interactive caller a shorter bound than a background job', () => {
    expect(maxBackoffFor('interactive')).toBe(INTERACTIVE_MAX_BACKOFF_MS)
    expect(maxBackoffFor('background')).toBe(BACKGROUND_MAX_BACKOFF_MS)
    expect(INTERACTIVE_MAX_BACKOFF_MS).toBeLessThan(BACKGROUND_MAX_BACKOFF_MS)
  })

  it('keeps the interactive bound under the base pause so a doomed retry never starts', () => {
    expect(INTERACTIVE_MAX_BACKOFF_MS).toBeLessThan(BASE_PAUSE_MS)
  })
})

describe('priorityOf', () => {
  it('treats an unlabelled request as interactive', () => {
    // Every call site that predates the lane split is a user-facing tool call,
    // so the safe default is the lane that fails fast rather than the one that
    // waits minutes on nobody's behalf.
    expect(priorityOf({ url: 'https://api.discogs.com/x', method: 'GET', headers: {} })).toBe('interactive')
  })

  it('honours an explicit priority', () => {
    expect(priorityOf({ url: 'https://api.discogs.com/x', method: 'GET', headers: {}, priority: 'background' })).toBe('background')
    expect(priorityOf({ url: 'https://api.discogs.com/x', method: 'GET', headers: {}, priority: 'interactive' })).toBe('interactive')
  })
})

describe('queueInsertIndex', () => {
  it('appends a background entry to the tail', () => {
    expect(queueInsertIndex([], 'background')).toBe(0)
    expect(queueInsertIndex(['interactive', 'background'], 'background')).toBe(2)
  })

  it('puts an interactive entry ahead of the first background entry', () => {
    // The 2026-08-04 case: the sync had re-queued itself at the head and was
    // consuming every probe token, so a user's tool call sat behind a
    // page-by-page collection walk.
    expect(queueInsertIndex(['background', 'background'], 'interactive')).toBe(0)
    expect(queueInsertIndex(['interactive', 'background'], 'interactive')).toBe(1)
  })

  it('keeps interactive entries in arrival order among themselves', () => {
    expect(queueInsertIndex(['interactive', 'interactive'], 'interactive')).toBe(2)
  })

  it('appends an interactive entry when nothing is queued behind it', () => {
    expect(queueInsertIndex([], 'interactive')).toBe(0)
  })
})

describe('shouldTripCircuit', () => {
  it('does not trip below the threshold', () => {
    for (let n = 0; n < TRIP_THRESHOLD; n++) {
      expect(shouldTripCircuit(n)).toBe(false)
    }
  })

  it('trips at and above the threshold', () => {
    expect(shouldTripCircuit(TRIP_THRESHOLD)).toBe(true)
    expect(shouldTripCircuit(TRIP_THRESHOLD + 1)).toBe(true)
  })
})

describe('isInCooldown', () => {
  it('returns false when trippedUntil is null', () => {
    expect(isInCooldown(null, 1_000_000)).toBe(false)
  })

  it('returns true while now is before trippedUntil', () => {
    expect(isInCooldown(2_000, 1_999)).toBe(true)
  })

  it('returns false once now reaches trippedUntil', () => {
    expect(isInCooldown(2_000, 2_000)).toBe(false)
    expect(isInCooldown(2_000, 2_001)).toBe(false)
  })
})

describe('cooldownRetryAfterSecs', () => {
  it('rounds up the seconds remaining', () => {
    expect(cooldownRetryAfterSecs(10_500, 10_000)).toBe(1)
    expect(cooldownRetryAfterSecs(11_001, 10_000)).toBe(2)
  })

  it('returns 0 when cooldown has elapsed', () => {
    expect(cooldownRetryAfterSecs(10_000, 11_000)).toBe(0)
  })
})

describe('getPauseMs', () => {
  it('honours Retry-After when Discogs sends one', () => {
    expect(getPauseMs(1, '30')).toBe(30_000)
    expect(getPauseMs(3, '5')).toBe(5_000)
  })

  it('ignores an absent, unparseable, or non-positive Retry-After', () => {
    expect(getPauseMs(1)).toBe(BASE_PAUSE_MS)
    expect(getPauseMs(1, 'soon')).toBe(BASE_PAUSE_MS)
    expect(getPauseMs(1, '0')).toBe(BASE_PAUSE_MS)
    expect(getPauseMs(1, '-5')).toBe(BASE_PAUSE_MS)
  })

  it('doubles per attempt when there is no Retry-After', () => {
    expect(getPauseMs(1)).toBe(60_000)
    expect(getPauseMs(2)).toBe(120_000)
    expect(getPauseMs(3)).toBe(240_000)
  })

  it('caps the backoff', () => {
    expect(getPauseMs(10)).toBe(MAX_PAUSE_MS)
  })

  it('treats attempt 0 as the first attempt rather than halving the base', () => {
    expect(getPauseMs(0)).toBe(BASE_PAUSE_MS)
  })
})

describe('countsTowardStreak', () => {
  it("counts an entry's first 429", () => {
    expect(countsTowardStreak(1)).toBe(true)
  })

  it('ignores that same entry retrying itself', () => {
    // Regression guard for #46: counting every attempt let a single request
    // trip a global 10-minute breaker on its own.
    expect(countsTowardStreak(2)).toBe(false)
    expect(countsTowardStreak(3)).toBe(false)
  })

  it('needs TRIP_THRESHOLD distinct entries to trip the circuit', () => {
    let streak = 0
    // One entry exhausting all its attempts.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ENTRY; attempt++) {
      if (countsTowardStreak(attempt)) streak++
    }
    expect(streak).toBe(1)
    expect(shouldTripCircuit(streak)).toBe(false)

    // TRIP_THRESHOLD different entries each failing once.
    streak = 0
    for (let entry = 0; entry < TRIP_THRESHOLD; entry++) {
      if (countsTowardStreak(1)) streak++
    }
    expect(shouldTripCircuit(streak)).toBe(true)
  })
})

describe('decayStreak', () => {
  const now = 1_000_000_000

  it('keeps a recent streak', () => {
    expect(decayStreak(2, now - 1000, now)).toBe(2)
    expect(decayStreak(2, now - STREAK_DECAY_MS, now)).toBe(2)
  })

  it('discards a streak too old to describe the current state', () => {
    // Regression guard for #47: the streak persists in DO storage across
    // restarts and deploys, leaving the limiter primed to trip on one 429.
    expect(decayStreak(2, now - STREAK_DECAY_MS - 1, now)).toBe(0)
    expect(decayStreak(2, 0, now)).toBe(0)
  })
})

describe('budgetAfterReset', () => {
  it('resets to the full limit when there is no recent 429', () => {
    expect(budgetAfterReset(60, 0)).toBe(60)
  })

  it('assumes a single throttled probe when a 429 is in the recent past', () => {
    expect(budgetAfterReset(60, 1)).toBe(PROBE_BUDGET)
    expect(budgetAfterReset(60, TRIP_THRESHOLD - 1)).toBe(PROBE_BUDGET)
  })

  it('throttles that probe rather than firing it immediately', () => {
    expect(getDelay(budgetAfterReset(60, 1))).toBeGreaterThan(0)
    expect(getDelay(budgetAfterReset(60, 0))).toBe(0)
  })
})
