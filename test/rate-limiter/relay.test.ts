// ABOUTME: Unit tests for the egress-relay helpers the rate limiter uses to route
// ABOUTME: Discogs calls through a self-hosted tunnel and to detect relay-layer failures.
import { describe, it, expect } from 'vitest'

import { relayConfigFrom, relayTarget, relayHeaders, isRelayLayerError, DISCOGS_ORIGIN } from '../../src/rate-limiter/relay'

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
