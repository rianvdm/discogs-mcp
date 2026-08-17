// ABOUTME: Routes Discogs API calls through an optional self-hosted egress relay so
// ABOUTME: they leave from an IP we own instead of Cloudflare's shared pool.

/** The origin every Discogs API URL in this codebase starts with. */
export const DISCOGS_ORIGIN = 'https://api.discogs.com'

/**
 * Where to send Discogs traffic instead of api.discogs.com, and how to get past
 * the Cloudflare Access application that guards it.
 *
 * Why a relay exists: Discogs throttles by source IP (60 req/min authenticated),
 * and a Worker's outbound fetch shares Cloudflare's egress IPs with every other
 * Worker on the same colo. The relay is a Cloudflare Tunnel to a machine we
 * control; requests exit from that machine's IP and the whole budget is ours.
 * The relay host restores `Host` and `X-Forwarded-Host` to api.discogs.com, so
 * OAuth 1.0a signatures computed against the real URL keep verifying.
 */
export interface RelayConfig {
	/** Origin of the relay, no trailing slash, e.g. https://relay.discogs-mcp.com */
	origin: string
	/** Cloudflare Access service token, sent as CF-Access-Client-Id. */
	clientId: string
	/** Cloudflare Access service token, sent as CF-Access-Client-Secret. */
	clientSecret: string
}

/** The subset of the Worker env the relay reads. All optional: unset means direct. */
export interface RelayEnv {
	DISCOGS_RELAY_ORIGIN?: string
	RELAY_ACCESS_CLIENT_ID?: string
	RELAY_ACCESS_CLIENT_SECRET?: string
}

/**
 * Build the relay config from env, or null when the relay is off.
 *
 * All three values must be present. An origin without credentials would only
 * ever produce Access 401s, so it is treated as "not configured" rather than
 * half-configured; the log line at startup says which.
 */
export function relayConfigFrom(env: RelayEnv): RelayConfig | null {
	const origin = env.DISCOGS_RELAY_ORIGIN?.trim().replace(/\/+$/, '')
	const clientId = env.RELAY_ACCESS_CLIENT_ID?.trim()
	const clientSecret = env.RELAY_ACCESS_CLIENT_SECRET?.trim()
	if (!origin || !clientId || !clientSecret) return null
	return { origin, clientId, clientSecret }
}

/**
 * The URL to actually fetch. Only URLs on the Discogs origin are rewritten; the
 * path and query are carried over untouched so the request Discogs eventually
 * sees is byte-for-byte what was signed.
 */
export function relayTarget(url: string, relay: RelayConfig | null): string {
	if (!relay || !url.startsWith(`${DISCOGS_ORIGIN}/`)) return url
	return relay.origin + url.slice(DISCOGS_ORIGIN.length)
}

/** The request headers plus the Access service-token pair the relay requires. */
export function relayHeaders(headers: Record<string, string>, relay: RelayConfig | null): Record<string, string> {
	if (!relay) return headers
	return {
		...headers,
		'CF-Access-Client-Id': relay.clientId,
		'CF-Access-Client-Secret': relay.clientSecret,
	}
}

/**
 * Whether a response came from the relay path rather than from the Discogs API,
 * in which case the caller should retry the request directly.
 *
 * The Discogs API answers in JSON and stamps every response with
 * `x-discogs-*` headers, including its errors. Anything else with an error
 * status is one of the layers in front of it: Cloudflare's 530 when the tunnel
 * has no connector, cloudflared's 502 when the machine's local proxy is down,
 * Access's HTML 401 when the service token is wrong, or an HTML 404 when the
 * relay is misrouting. Falling back on those keeps a dead relay from becoming
 * an outage; the worst case is the shared-IP behaviour we had before.
 *
 * A 429 is never a relay-layer error. Retrying a throttle on the shared IP would
 * spend a second budget behind the limiter's back.
 */
export function isRelayLayerError(status: number, headers: Record<string, string>): boolean {
	if (status < 400 || status === 429) return false
	const fromDiscogs = Object.keys(headers).some((key) => key.toLowerCase().startsWith('x-discogs-'))
	if (fromDiscogs) return false
	const contentType = headers['content-type'] ?? headers['Content-Type'] ?? ''
	return !contentType.toLowerCase().includes('application/json')
}

/** What the rate limiter reports about the relay through its `/state` endpoint. */
export interface RelayStatus {
	enabled: boolean
	/** Relay origin when enabled, else null. */
	origin: string | null
	/** Wall-clock ms of the most recent fallback to a direct call; null = none recorded. */
	lastFallbackAt: number | null
	/** Fallbacks recorded so far. Persisted by the DO, so it survives restarts. */
	fallbacks: number
}

/** "just now", "4 min ago", "3 h ago", "2 d ago" — coarse on purpose, this is a status line. */
export function describeAge(sinceMs: number, now: number): string {
	const s = Math.max(0, Math.round((now - sinceMs) / 1000))
	if (s < 60) return 'just now'
	const m = Math.round(s / 60)
	if (m < 60) return `${m} min ago`
	const h = Math.round(m / 60)
	if (h < 24) return `${h} h ago`
	return `${Math.round(h / 24)} d ago`
}

/**
 * One human-readable line for `ping` / `server_info` saying how Discogs traffic
 * is leaving and whether the relay has failed lately. The relay falls back to
 * direct calls silently as far as tool results go, so this is where a user
 * finds out that the relay host is down.
 */
export function describeRelayStatus(status: RelayStatus | null, now: number): string {
	if (!status) return 'Discogs egress: status unavailable (rate limiter did not answer)'
	if (!status.enabled) return 'Discogs egress: direct from Cloudflare (no relay configured)'
	const host = status.origin ? new URL(status.origin).host : 'relay'
	if (status.fallbacks === 0 || status.lastFallbackAt === null) return `Discogs egress: via relay ${host}, no fallbacks recorded`
	const times = status.fallbacks === 1 ? 'once' : `${status.fallbacks} times`
	return `Discogs egress: via relay ${host}; fell back to direct ${times}, last ${describeAge(status.lastFallbackAt, now)} — the relay host may be down`
}
