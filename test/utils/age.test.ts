// ABOUTME: Tests for the coarse "how long ago" formatter shared by the relay status
// ABOUTME: line and the collection sync summary.
import { describe, it, expect } from 'vitest'
import { describeAge } from '../../src/utils/age'

describe('describeAge', () => {
	it('rounds to the coarsest sensible unit', () => {
		const now = 1_000_000_000
		expect(describeAge(now - 20_000, now)).toBe('just now')
		expect(describeAge(now - 4 * 60_000, now)).toBe('4 min ago')
		expect(describeAge(now - 3 * 3_600_000, now)).toBe('3 h ago')
		expect(describeAge(now - 2 * 86_400_000, now)).toBe('2 d ago')
	})
})
