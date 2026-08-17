// ABOUTME: Unit tests for the egress-relay helpers the rate limiter uses to route
// ABOUTME: Discogs calls through a self-hosted tunnel and to detect relay-layer failures.
import { describe, it, expect } from 'vitest'

import {
	relayConfigFrom,
	relayTarget,
	relayHeaders,
	isRelayLayerError,
	describeAge,
	describeRelayStatus,
	DISCOGS_ORIGIN,
} from '../../src/rate-limiter/relay'

const relay = { origin: 'https://relay.example.com', clientId: 'id.access', clientSecret: 'shh' }

describe('relayConfigFrom', () => {
	it('is null when no relay origin is configured', () => {
		expect(relayConfigFrom({})).toBeNull()
		expect(relayConfigFrom({ DISCOGS_RELAY_ORIGIN: '' })).toBeNull()
		expect(relayConfigFrom({ DISCOGS_RELAY_ORIGIN: '   ' })).toBeNull()
	})

	it('is null when the origin is set but the Access credentials are not', () => {
		expect(relayConfigFrom({ DISCOGS_RELAY_ORIGIN: 'https://relay.example.com' })).toBeNull()
		expect(relayConfigFrom({ DISCOGS_RELAY_ORIGIN: 'https://relay.example.com', RELAY_ACCESS_CLIENT_ID: 'id' })).toBeNull()
	})

	it('normalises a trailing slash off the origin', () => {
		expect(
			relayConfigFrom({
				DISCOGS_RELAY_ORIGIN: 'https://relay.example.com/',
				RELAY_ACCESS_CLIENT_ID: 'id.access',
				RELAY_ACCESS_CLIENT_SECRET: 'shh',
			}),
		).toEqual(relay)
	})
})

describe('relayTarget', () => {
	it('rewrites the Discogs origin to the relay and keeps path and query intact', () => {
		expect(relayTarget(`${DISCOGS_ORIGIN}/database/search?q=nirvana&per_page=1`, relay)).toBe(
			'https://relay.example.com/database/search?q=nirvana&per_page=1',
		)
	})

	it('leaves a URL alone when there is no relay', () => {
		const url = `${DISCOGS_ORIGIN}/releases/1`
		expect(relayTarget(url, null)).toBe(url)
	})

	it('leaves a non-Discogs URL alone even with a relay configured', () => {
		expect(relayTarget('https://example.org/x', relay)).toBe('https://example.org/x')
	})

	it('does not rewrite a URL that merely mentions the Discogs host', () => {
		expect(relayTarget('https://evil.example/https://api.discogs.com/x', relay)).toBe('https://evil.example/https://api.discogs.com/x')
	})
})

describe('relayHeaders', () => {
	it('adds the Access service-token headers without touching the rest', () => {
		expect(relayHeaders({ Authorization: 'OAuth x', 'User-Agent': 'ua' }, relay)).toEqual({
			Authorization: 'OAuth x',
			'User-Agent': 'ua',
			'CF-Access-Client-Id': 'id.access',
			'CF-Access-Client-Secret': 'shh',
		})
	})

	it('returns the headers unchanged when there is no relay', () => {
		const headers = { Authorization: 'OAuth x' }
		expect(relayHeaders(headers, null)).toEqual(headers)
	})
})

describe('isRelayLayerError', () => {
	it('flags a Cloudflare 530 with no Discogs headers (tunnel has no connector)', () => {
		expect(isRelayLayerError(530, { 'content-type': 'text/html', 'cf-ray': 'abc' })).toBe(true)
	})

	it('flags an Access 401 (HTML, no Discogs headers)', () => {
		expect(isRelayLayerError(401, { 'content-type': 'text/html; charset=utf-8' })).toBe(true)
	})

	it('flags a 502 from cloudflared when the local proxy is down', () => {
		expect(isRelayLayerError(502, { 'content-type': 'text/plain' })).toBe(true)
	})

	it('flags an HTML 404 that is not the Discogs API answering', () => {
		expect(isRelayLayerError(404, { 'content-type': 'text/html' })).toBe(true)
	})

	it('does not flag a Discogs 401 (JSON) — that is a real auth failure', () => {
		expect(isRelayLayerError(401, { 'content-type': 'application/json' })).toBe(false)
	})

	it('does not flag a Discogs 404 that carries the API rate-limit headers', () => {
		expect(isRelayLayerError(404, { 'x-discogs-ratelimit': '60', 'content-type': 'text/html' })).toBe(false)
	})

	it('never flags a 429, so a throttle is surfaced rather than retried on the shared IP', () => {
		expect(isRelayLayerError(429, { 'content-type': 'text/html' })).toBe(false)
	})

	it('never flags a success', () => {
		expect(isRelayLayerError(200, {})).toBe(false)
		expect(isRelayLayerError(204, {})).toBe(false)
	})
})

describe('describeAge', () => {
	it('rounds to the coarsest sensible unit', () => {
		const now = 1_000_000_000
		expect(describeAge(now - 20_000, now)).toBe('just now')
		expect(describeAge(now - 4 * 60_000, now)).toBe('4 min ago')
		expect(describeAge(now - 3 * 3_600_000, now)).toBe('3 h ago')
		expect(describeAge(now - 2 * 86_400_000, now)).toBe('2 d ago')
	})
})

describe('describeRelayStatus', () => {
	const now = 1_000_000_000

	it('says so when the limiter could not be asked', () => {
		expect(describeRelayStatus(null, now)).toContain('status unavailable')
	})

	it('reports direct egress when no relay is configured', () => {
		expect(describeRelayStatus({ enabled: false, origin: null, lastFallbackAt: null, fallbacks: 0 }, now)).toBe(
			'Discogs egress: direct from Cloudflare (no relay configured)',
		)
	})

	it('names the relay host and a clean record', () => {
		expect(describeRelayStatus({ enabled: true, origin: 'https://relay.example.com', lastFallbackAt: null, fallbacks: 0 }, now)).toBe(
			'Discogs egress: via relay relay.example.com, no fallbacks recorded',
		)
	})

	it('surfaces fallbacks with a count and an age, and points at the relay host', () => {
		const line = describeRelayStatus(
			{ enabled: true, origin: 'https://relay.example.com', lastFallbackAt: now - 4 * 60_000, fallbacks: 3 },
			now,
		)
		expect(line).toBe(
			'Discogs egress: via relay relay.example.com; fell back to direct 3 times, last 4 min ago — the relay host may be down',
		)
	})

	it('says "once" for a single fallback', () => {
		expect(
			describeRelayStatus({ enabled: true, origin: 'https://relay.example.com', lastFallbackAt: now - 1000, fallbacks: 1 }, now),
		).toContain('fell back to direct once, last just now')
	})
})
