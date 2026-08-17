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
