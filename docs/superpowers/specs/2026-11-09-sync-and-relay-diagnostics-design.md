# Sync and Relay Diagnostics: Design

**Date:** 2026-11-09
**Status:** Draft
**Author:** Rian van der Merwe
**Source:** [#89](https://github.com/rianvdm/discogs-mcp/issues/89) (tenold, self-hosted v3.5.0, ~4,200 releases, Workers Free)

## Problem

A self-hoster's scheduled sync failed four times a day for two weeks, and nothing they could see from an MCP client said so. The root cause was Discogs throttling Cloudflare's shared egress IP, which the existing relay fixes. That part is solved. What remains is that each failure along the way was hard to see or misreported:

1. **The failing cron is invisible.** `logSyncOutcome` in `src/index-oauth.ts` only writes to `console`. `get_cache_stats` shows the snapshot's `fetchedAt` and any sync in progress (`src/sync/status.ts`), but not whether the last run failed, why, or how many runs in a row have failed. A stale `fetchedAt` doesn't tell you this either, because a healthy `skipped` run (probe unchanged) leaves `fetchedAt` where it was.
2. **`pagesFetched` reports the stored progress marker, not pages fetched.** On resume, `lastPageFetched` is seeded from the progress record (`src/sync/collectionSync.ts:90`), and both the failure return (`:156`) and the success return (`:195`) report it. A resumed sweep that 429s on its first request says `pagesFetched: 15`.
3. **A throttled probe is reported as a crash.** The probe's `fetchPageWithRetry` (`src/sync/collectionSync.ts`, inside the `existingSnapshot && lastForcedFresh` block) sits outside the `try`, so a probe that fails after its retries throws out of `syncCollection`. The cron's outer `catch` then logs `crashed` with `pagesFetched: 0`. A 429 is a `failed`, not a `crashed`.
4. **A half-configured relay is silently off.** `relayConfigFrom` (`src/rate-limiter/relay.ts`) returns `null` unless all three values are set. Its doc comment says "the log line at startup says which," but the Durable Object constructor (`src/rate-limiter/durable-object.ts:242`) only logs "Egress relay off". `ping` and `server_info` then report "direct from Cloudflare (no relay configured)", which reads as intentional.
5. **The README undersells the relay and omits two traps.** "If it bites" frames the relay as an edge case; three reports (#52, #83, #89) say direct egress can stay throttled indefinitely. The README only describes the Tunnel + Access setup, though any always-on proxy that checks the service-token headers works. And it doesn't say that plain variables set in the Cloudflare dashboard are removed by the next `wrangler deploy`, which is how tenold lost a relay value.

## Goals

- A self-hoster calling `get_cache_stats` can see the last sync's outcome, when it ran, what triggered it, the error if it failed, how many runs in a row have failed, and when the last healthy run was.
- `pagesFetched` means Discogs page fetches made by this invocation, everywhere it appears.
- A probe that fails on a Discogs or network error is reported as `failed` with the error message, the same as a page fetch already is. A revoked token stays `token_invalid`.
- A relay with an origin but missing credentials is reported as misconfigured, by variable name, in the Worker log and in `ping` / `server_info`.
- The README tells a self-hoster when they need the relay, what any relay must do, and where each relay value must live.

## Non-goals

- **Changing rate-limiter behaviour.** The background lane already waits up to 90 s (`BACKGROUND_MAX_BACKOFF_MS`, shipped in #50); waiting longer doesn't help an IP that refuses the first request. Backoff, circuit breaker, and lanes stay as they are. #51 stays a separate issue.
- **Per-user sync state in `server_info`.** `server_info` and `ping` are unauthenticated; sync state is per user. `get_cache_stats` is the authenticated sync-health tool and stays the only place it appears.
- **Incremental sync** (tenold's fork). The probe already skips unchanged collections, and the weekly forced sweep catches removals. A PR from them can be judged on its own.
- **Shipping a reference relay proxy.** The README states the requirements; maintaining a proxy implementation is a separate decision.
- **Alerting.** No email, webhook, or push on failure. The persisted record makes a later alert possible but this change doesn't add one.
- **Validating the relay origin's URL syntax.** A malformed origin is a separate failure mode; note it in `development/todo.md` if found, don't fix it here.

## Anti-goals

- Never write a secret value to a log line, a tool result, or KV. Misconfiguration messages name variables only.
- Don't add KV writes per page or per request. The free plan's daily write cap is already spent mostly by page persistence (two writes per page); this change adds at most one write per sync run.
- Don't add CPU-heavy work to `get_cache_stats`. It already parses the whole snapshot, which crowds the 10 ms free-plan budget on 4,000+ item collections. The new record must be small (well under 2 KB) and read with one `kv.get`.
- Don't change the snapshot, progress, or page key formats. Existing deployments must upgrade without a resync.

## Design

### 1. Last sync outcome record

**Key:** `collection:sync:lastOutcome:{numericId}` in `MCP_SESSIONS`, added to `src/sync/keys.ts` as `lastOutcomeKey`.

**Shape** (new type in `src/sync/types.ts`):

```ts
export interface LastSyncRecord {
	schemaVersion: 1
	outcome: SyncOutcome
	trigger: 'scheduled' | 'manual'
	/** ISO time the run finished. */
	at: string
	pagesFetched: number
	count?: number
	/** Truncated to 500 characters. */
	error?: string
	/** Runs in a row whose outcome was failed, crashed, or token_invalid, including this one. 0 when this run was healthy. */
	consecutiveFailures: number
	/** ISO time of the most recent completed, resumed, or skipped run; null if none recorded yet. */
	lastHealthyAt: string | null
}
```

**Outcome classes** (my call):

- Healthy: `completed`, `resumed`, `skipped`. Resets `consecutiveFailures` to 0 and sets `lastHealthyAt` to `at`.
- Failing: `failed`, `crashed`, `token_invalid`. Increments `consecutiveFailures` and carries `lastHealthyAt` forward from the previous record.
- Neutral: `no_token`, `in_progress`. Recorded as the latest outcome, carries both counters forward unchanged. `no_token` means the user hasn't signed in since the token mirror was added, which isn't a sync failure.

**Writer:** one function, `recordSyncOutcome(kv, numericId, result, trigger, now)` in a new `src/sync/lastOutcome.ts`. It reads the previous record (ignoring any with another `schemaVersion`), computes the counters, and writes the new record with a 30-day `expirationTtl` so a user removed from the allowlist doesn't leave a record behind forever (my call). It must never throw: a KV failure is logged and swallowed, because losing a diagnostic must not fail a sync or a tool call.

**Concurrency** (my call): the read-modify-write is unguarded and last-writer-wins. `refresh_collection` deliberately allows overlapping runs (`src/mcp/tools/authenticated.ts:620-624`), so a manual and a scheduled run finishing together can lose one increment or let an older result land last. That's acceptable for a diagnostic, and coordinating writes through the DO would cost more than it's worth. The `get_cache_stats` wording should not imply the streak is exact to the run (say "about 9 runs in a row" only if the builder finds it reads better; a plain count is fine).

**Call sites:**

- `logSyncOutcome` in `src/index-oauth.ts` keeps its `console.log` line and also calls `recordSyncOutcome(..., 'scheduled', ...)`. That covers `completed`/`skipped`/`failed` from `syncCollection`, plus the `no_token`, `token_invalid`, and `crashed` paths in the scheduled handler.
- `refresh_collection` in `src/mcp/tools/authenticated.ts` calls `recordSyncOutcome(..., 'manual', ...)` after `syncCollection` returns. If `syncCollection` throws (a snapshot write failing, for example), it records `crashed` with the error message, then rethrows so the tool's existing error behaviour doesn't change (my call).

**Reader:** `describeSyncState` in `src/sync/status.ts` reads the record and adds lines under "Collection Sync" in `get_cache_stats`. Exact wording is the builder's call, but it must carry this information:

- Healthy: `Last sync: skipped (no changes), scheduled, 2 h ago`
- Failing: `Last sync: FAILED, scheduled, 2 h ago. 9 runs in a row have failed; last healthy run 14 d ago. Error: <message>`
- Failing, never healthy: `... no healthy run recorded yet`
- No record: `Last sync: none recorded yet` (a fresh deploy, or a deployment from before this change).

When the last sync failed and `ping`'s egress line says direct, append one hint line pointing at the README's relay section. The builder decides whether that cross-reference is worth the extra DO call from `get_cache_stats`; if not, a static hint on any `failed` outcome whose error mentions 429 is enough.

Ages use the existing `describeAge` helper, moved from `src/rate-limiter/relay.ts` to `src/utils/` so sync code doesn't import from the rate limiter (my call). `relay.ts` imports it from the new location.

### 2. `pagesFetched` counts this invocation's fetches

`syncCollection` keeps a counter of Discogs page fetches that succeeded in this invocation, including the probe, and reports that as `pagesFetched` on every return path. When a drift check or a missing stored page restarts the sync recursively, the restarted call's count includes the pages fetched before the restart (pass the running count down; the builder picks the mechanism).

Progress stays visible separately. Add two optional fields to `SyncResult`, populated on `failed` and `resumed`:

- `syncedThroughPage`: the last page whose `persistPage` succeeded for the current sweep, or the stored marker on a resume where nothing new was stored.
- `totalPages`: the sweep's page count.

`refresh_collection`'s JSON output includes them when present. The cron's log line gets them through the existing spread.

Today `lastPageFetched = page` runs before `await persistPage(...)` (`src/sync/collectionSync.ts:150-151`), so it can name a page whose write failed. `syncedThroughPage` must only advance after `persistPage` resolves, either by moving that assignment below the `await` or by tracking it separately (builder's call). The progress record itself is unaffected, since `persistPage` already writes the page before the progress pointer.

### 3. A failed probe returns `failed`

Treat a probe fetch error the way the pagination loop already treats a page fetch error: return `{ outcome: 'failed', pagesFetched: 0, error }` instead of throwing.

One exception: an error that the scheduled handler would classify as a revoked token (its `/\b401\b|Unauthorized/i` test, `src/index-oauth.ts:410`) still throws. Today that throw is what makes the cron delete the token mirror and log `token_invalid`; catching it would leave a dead token retried four times a day. Extract the test into a shared helper (for example `isUnauthorizedError` in `src/sync/`) used by both the probe and the scheduled handler, so the two can't drift.

Scope of the distinction (my call): `failed` means `syncCollection` returned a failure, `crashed` means it threw. The pagination loop's existing `catch` also turns KV and mapping errors into `failed` (`src/sync/collectionSync.ts:132-158`); narrowing it is out of scope. The same 401 gap exists mid-sweep (a revoked token during pagination returns `failed` and skips cleanup); note it in `development/todo.md` as P2 rather than fixing it here.

### 4. Relay misconfiguration is named

Add to `src/rate-limiter/relay.ts`:

```ts
/** Names of the relay credentials that are missing while DISCOGS_RELAY_ORIGIN is set. Empty when the relay is fully configured or deliberately off. */
export function missingRelayCredentials(env: RelayEnv): string[]
```

Rules: if `DISCOGS_RELAY_ORIGIN` is unset or blank after trimming, return `[]` (relay deliberately off, even if secrets are still set). Otherwise return the names of whichever of `RELAY_ACCESS_CLIENT_ID` / `RELAY_ACCESS_CLIENT_SECRET` are unset or blank after trimming.

- The DO constructor logs `console.warn('[RL] Egress relay OFF: DISCOGS_RELAY_ORIGIN is set but RELAY_ACCESS_CLIENT_SECRET is missing ...')` when the list is non-empty, in place of the plain "relay off" line.
- `RelayStatus` gains `missingCredentials: string[]`, filled by `relayStatus()` in the DO. It's read through `/state`, so it also shows in `/debug/budget`.
- `describeRelayStatus` reports it ahead of the "no relay configured" case: `Discogs egress: direct from Cloudflare. The relay is NOT active: DISCOGS_RELAY_ORIGIN is set but RELAY_ACCESS_CLIENT_SECRET is missing. Set it with wrangler secret put.` A status from an older DO without the field is treated as `[]`.
- The doc comment on `relayConfigFrom` is corrected to match.

### 5. README

In "Route Discogs calls through your own IP":

- Open with when you need it: on Workers, direct calls to Discogs can be throttled on the first request and stay throttled for days, because the egress IP is shared. If `get_cache_stats` shows repeated 429 failures, set up the relay. Keep the existing explanation of why.
- State the contract any relay must meet, then give the two known setups. Contract: forward path and query unchanged to `https://api.discogs.com`; Discogs must see `Host: api.discogs.com` and either no `X-Forwarded-Host` or one equal to `api.discogs.com`; pass `Authorization` and `User-Agent` through; return Discogs' status and `x-discogs-*` headers unchanged, 429s included; refuse any request without the right `CF-Access-Client-Id` / `CF-Access-Client-Secret`, so it isn't an open proxy. Setups: the existing Tunnel + Access description, and a small always-on proxy on a VPS or container host that checks the two headers itself (credit #89 for the Fly.io version).
- Add the placement note: `DISCOGS_RELAY_ORIGIN` goes in `wrangler.toml` under `[vars]`; both credentials go in with `wrangler secret put`. A plain variable added in the dashboard is removed by the next `wrangler deploy` (unless `keep_vars = true`); secrets survive. Check against the [Wrangler configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/) before writing it.
- Say that `ping` / `server_info` name any missing relay credential.

In "Collection size and the free plan" and "Diagnostics": mention that `get_cache_stats` reports the last sync's outcome and failure streak.

In the agent setup prompt's step 8: mention the VPS-proxy alternative in one clause.

Comments in `wrangler.toml` around `DISCOGS_RELAY_ORIGIN` get the same placement note in one line.

## Testing

Existing suites, extended (Vitest with the Workers pool, Discogs mocked):

- `test/sync/collectionSync.spec.ts`: resume then fail on the first fetch reports `pagesFetched: 0` and `syncedThroughPage` equal to the stored marker; resume then complete reports only the pages fetched this run; probe hit counts 1; drift restart counts pages from both passes; a probe fetch failure returns `failed` with the error; a probe 401 still throws; a `persistPage` failure leaves `syncedThroughPage` at the previous page.
- New `test/sync/lastOutcome.spec.ts`: each outcome class updates the counters as specified; carry-forward across a failing streak; a record with another `schemaVersion` is ignored; the error is truncated; a KV write failure doesn't throw; the TTL is set.
- `test/sync/scheduled.spec.ts`: the scheduled handler writes a record with `trigger: 'scheduled'` for completed, failed, `no_token`, `token_invalid`, and `crashed`; a probe 401 still deletes the token mirror.
- `test/sync/refresh-collection-tool.spec.ts`: writes a `manual` record; output includes `syncedThroughPage` / `totalPages` when present; a throwing sync records `crashed` and the tool's error behaviour is unchanged.
- `test/sync/cache-stats-sync-state.spec.ts`: renders the healthy, failing, never-healthy, and no-record cases.
- `test/rate-limiter/relay.test.ts`: `missingRelayCredentials` for all combinations, including blank strings and "secrets set, origin blank"; `describeRelayStatus` with missing credentials and with an old status that lacks the field; `describeAge` still passes from its new location.
- `test/rate-limiter/durable-object.test.ts`: `/state` includes `missingCredentials`.

No test asserts on a secret's value appearing anywhere, because none should; add one test that the misconfiguration line contains the variable name and not a sample secret value.

## Delivery

- One branch (`fix/issue-89-sync-relay-diagnostics`), one PR that closes #89's actionable parts and links back to it.
- Version bump and release notes follow the repo's existing release process; whether this ships as 3.8.1 or 3.9.0 is the builder's call (new tool output, no new tools suggests a minor).
- A reply to #89 is drafted separately and shown to Rian before posting. It thanks tenold, says what shipped, explains why the longer cron backoff and `server_info` suggestions weren't taken, and recommends upgrading from v3.5.0 (v3.8.0's #84 routes OAuth sign-in through the relay; #56/#57 fixed the free-plan sync).

## Left to the builder

- Exact wording of the `get_cache_stats` and egress lines, within the content rules above.
- Whether `get_cache_stats` asks the DO for egress status or uses the static 429 hint.
- How the running page count reaches a recursive restart.
- Where `describeAge` lands under `src/utils/`.
- Commit breakdown.
