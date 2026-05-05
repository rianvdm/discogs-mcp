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
  MAX_ATTEMPTS_PER_ENTRY,
  TRIP_THRESHOLD,
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
