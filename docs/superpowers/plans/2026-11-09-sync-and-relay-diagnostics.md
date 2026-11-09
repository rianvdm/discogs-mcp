# Sync and Relay Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a failing background sync, a misreported page count, a throttled probe, and a half-configured relay visible and correctly reported, and document the relay as the fix for shared-IP throttling (#89).

**Architecture:** `syncCollection` gets accurate per-invocation page accounting and returns `failed` for a probe fetch error. A new `src/sync/lastOutcome.ts` persists one small KV record per sync run, written from the scheduled handler and `refresh_collection` and rendered by `describeSyncState` in `get_cache_stats`. `relay.ts` names missing relay credentials, and the Durable Object surfaces them through `/state` to `ping` / `server_info`.

**Tech Stack:** TypeScript (strict), Cloudflare Workers, KV, Durable Objects, Vitest 4 + `@cloudflare/vitest-pool-workers` 0.22, Node 22.

**Spec:** `docs/superpowers/specs/2026-11-09-sync-and-relay-diagnostics-design.md`

## Global Constraints

- Every new code file starts with two `// ABOUTME: ` lines (AGENTS.md).
- Prettier: 140 width, single quotes, no semicolons, tabs. `npm run lint` and `npm run format:check` pass before every commit.
- No temporal names or comments ("new", "improved", "now does"). Comments describe the code as it is.
- Never write a secret value to a log line, a tool result, or KV. Misconfiguration messages name variables only.
- At most one KV read and one KV write added per sync run. No per-page or per-request writes.
- `LastSyncRecord` stays well under 2 KB; `error` is truncated to 500 characters.
- Record key: `collection:sync:lastOutcome:{numericId}`; `expirationTtl` 30 days = `2_592_000` seconds.
- Existing snapshot, progress, page, `lastForcedFullSync`, and token-mirror key formats do not change.
- Rate-limiter backoff, lanes, and circuit breaker do not change.
- Run tests with `npm test -- <path>`; the full suite with `npm test`.
- Work on branch `fix/issue-89-sync-relay-diagnostics` in `/Users/rian/git/discogs-mcp`. No worktrees.

## Review Focus

1. **An error message that is a multi-line HTML page** (a relay 502 body inside `HTTP 502: <html>…`). Expected: the stored `error` has whitespace collapsed to single spaces before truncation, so `get_cache_stats` stays one bullet per line. Test in Task 3.
2. **A corrupt or non-JSON outcome record in KV.** Expected: `recordSyncOutcome` treats it as no previous record, and `describeSyncState` shows "none recorded yet" instead of throwing. Tests in Tasks 3 and 4.
3. **A 429 whose body contains the number 401** (e.g. `"retryAfterSecs":401` from the circuit breaker). Expected: not treated as a revoked token, so the token mirror isn't deleted. The shared helper matches `HTTP 401` or the word `Unauthorized`, not a bare `401`. This narrows the scheduled handler's current `/\b401\b|Unauthorized/i`, which the spec quoted; narrowing is the correct reading of its intent. Test in Task 2.
4. **A `failed` outcome with no `error`.** Expected: no `Error: undefined` line. Test in Task 4.
5. **A failure that isn't a 429** (a 500, a relay 530). Expected: no relay hint. The hint appears only when the error contains `HTTP 429`. Test in Task 4.

---

### Task 1: Per-invocation page accounting in `syncCollection`

**Files:**
- Modify: `src/sync/types.ts` (`SyncResult`)
- Modify: `src/sync/collectionSync.ts`
- Test: `test/sync/collectionSync.spec.ts`, `test/sync/refresh-collection-tool.spec.ts`

**Interfaces:**
- Produces: `SyncResult` gains `syncedThroughPage?: number` and `totalPages?: number`. `pagesFetched` means successful Discogs page fetches made by this `syncCollection` call, including the probe and any pages fetched before a recursive restart.

- [ ] **Step 1: Write the failing tests** in `test/sync/collectionSync.spec.ts` (reuse `makeItem` / `makePage`):
  - `reports pagesFetched 0 and syncedThroughPage at the stored marker when a resumed sweep fails on its first fetch`: progress `{ schemaVersion: 2, startedAt: now, totalPages: 43, totalCount: 4300, lastPageFetched: 15 }`, client always throws. Expect `outcome: 'failed'`, `pagesFetched: 0`, `syncedThroughPage: 15`, `totalPages: 43`.
  - `counts only this run's fetches when a resumed sweep completes`: progress at page 1 of 2 with `pageKey(u, 1)` stored, client serves page 2. Expect `outcome: 'resumed'`, `pagesFetched: 1`, `syncedThroughPage: 2`, `totalPages: 2`.
  - `counts pages from both passes when a drift check restarts the sync`: first pass page 1 says 3 items, page 2 says 4; second pass consistent at 4 across 2 pages. Expect `pagesFetched: 4`.
  - `does not advance syncedThroughPage past a page whose write failed`: wrap `env.MCP_SESSIONS` in an object delegating `get`/`put`/`delete`/`list` whose `put` throws for `pageKey('u', 2)`; 3-page collection. Expect `outcome: 'failed'`, `syncedThroughPage: 1`, `totalPages: 3`.
  - `omits syncedThroughPage when a fresh sweep fails before storing a page`: no progress, client throws. Expect `result).not.toHaveProperty('syncedThroughPage')` and no `totalPages`.
  - Existing `persists progress and leaves snapshot untouched when retries are exhausted` gains `expect(result.syncedThroughPage).toBe(2)` and `expect(result.totalPages).toBe(3)`.

- [ ] **Step 2: Run** `npm test -- test/sync/collectionSync.spec.ts`. Expected: the new tests FAIL (resume case reports `pagesFetched: 15`).

- [ ] **Step 3: Implement.** Keep `export async function syncCollection(client, kv, numericId, opts): Promise<SyncResult>` as the public entry; move the body into a private `runSync(client, kv, numericId, opts, fetched: { pages: number })` that increments `fetched.pages` after each successful `fetchPageWithRetry` (probe included), and pass the same `fetched` object to the two recursive restarts. Assign `lastPageFetched = page` after `await persistPage(...)` resolves, not before. Report `pagesFetched: fetched.pages` on every return. Add `syncedThroughPage: lastPageFetched` and `totalPages` to `failed` and `resumed` results only when `lastPageFetched > 0`.

- [ ] **Step 4: Update** `test/sync/refresh-collection-tool.spec.ts` `returns status: resumed when a fresh progress key exists`: that resume runs zero fetches, so change `expect(result.pagesFetched).toBe(1)` to `toBe(0)`. Widen the `callRefresh` return type with `syncedThroughPage?: number; totalPages?: number`.

- [ ] **Step 5: Run** `npm test -- test/sync/`. Expected: all PASS. (`refresh_collection` already serialises the result fields it names; Task 3 adds the two new ones to its output.)

- [ ] **Step 6: Commit**

```bash
git add src/sync/types.ts src/sync/collectionSync.ts test/sync/collectionSync.spec.ts test/sync/refresh-collection-tool.spec.ts
git commit -m "fix(sync): report pages fetched by this run, not the stored progress marker (#89)"
```

---

### Task 2: A failed probe returns `failed`; one shared revoked-token test

**Files:**
- Create: `src/sync/errors.ts`
- Modify: `src/sync/collectionSync.ts` (probe block)
- Modify: `src/index-oauth.ts` (scheduled handler `catch`, around line 410)
- Modify: `development/todo.md`
- Test: `test/sync/errors.spec.ts` (create), `test/sync/collectionSync.spec.ts`, `test/sync/scheduled.spec.ts`

**Interfaces:**
- Produces: `export function isUnauthorizedError(err: unknown): boolean` in `src/sync/errors.ts`. True when the message matches `/\bHTTP 401\b/` or `/\bUnauthorized\b/i`.

- [ ] **Step 1: Write the failing tests.**
  - `test/sync/errors.spec.ts`: true for `new Error('Failed to search collection: HTTP 401: {"message":"You must authenticate"}')` and for `new Error('Unauthorized')`; false for `new Error('Failed to search collection: HTTP 429: {"error":"Discogs rate-limit circuit tripped","retryAfterSecs":401}')`, for a plain `HTTP 500` error, and for a non-Error value `'boom'`.
  - `test/sync/collectionSync.spec.ts`, using the probe setup from `skips full repaginate when count and topPageInstanceIds both match` (snapshot + fresh `lastForcedFullSyncKey`):
    - `returns failed with the error when the probe fetch fails`: client throws `HTTP 429: ...` on every call. Expect `outcome: 'failed'`, `pagesFetched: 0`, `error` containing `HTTP 429`, no `syncedThroughPage`.
    - `still throws when the probe fails with a revoked token`: client throws `Failed to search collection: HTTP 401: ...`. Expect `syncCollection(...)` to reject.
  - `test/sync/scheduled.spec.ts`, `deletes the token mirror when the probe sees a revoked token`: seed token mirror, snapshot, and fresh `lastForcedFullSyncKey` for `alpha`; `mockImplementationOnce` a client whose `searchCollection` rejects with the 401 message. Expect the token mirror key gone and a `sync` log event with `outcome: 'token_invalid'`.

- [ ] **Step 2: Run** `npm test -- test/sync/errors.spec.ts test/sync/collectionSync.spec.ts test/sync/scheduled.spec.ts`. Expected: FAIL (`errors.ts` missing; probe failure rejects).

- [ ] **Step 3: Implement.** Create `src/sync/errors.ts` with `isUnauthorizedError`. In `collectionSync.ts`, wrap only the probe's `fetchPageWithRetry` call: on error, rethrow if `isUnauthorizedError(err)`, otherwise return `{ outcome: 'failed', pagesFetched: fetched.pages, error: message }`. In `index-oauth.ts`, replace the inline regex test with `isUnauthorizedError(err)`.

- [ ] **Step 4: Add a P2 entry** to `development/todo.md` under its P2 section: "A revoked token during pagination (not the probe) returns `failed` from `syncCollection`, so the scheduled handler never deletes the token mirror; it retries a dead token four times a day. Found during #89."

- [ ] **Step 5: Run** `npm test -- test/sync/`. Expected: all PASS, including the existing `isolates per-user crashes` test (`alpha:failed`).

- [ ] **Step 6: Commit**

```bash
git add src/sync/errors.ts src/sync/collectionSync.ts src/index-oauth.ts development/todo.md test/sync/errors.spec.ts test/sync/collectionSync.spec.ts test/sync/scheduled.spec.ts
git commit -m "fix(sync): report a throttled probe as failed, keep revoked-token cleanup (#89)"
```

---

### Task 3: Persist the last sync outcome

**Files:**
- Modify: `src/sync/types.ts` (add `LastSyncRecord`, `SyncTrigger`)
- Modify: `src/sync/keys.ts` (add `lastOutcomeKey`)
- Create: `src/sync/lastOutcome.ts`
- Modify: `src/index-oauth.ts` (`logSyncOutcome`)
- Modify: `src/mcp/tools/authenticated.ts` (`refresh_collection`)
- Test: `test/sync/lastOutcome.spec.ts` (create), `test/sync/scheduled.spec.ts`, `test/sync/refresh-collection-tool.spec.ts`

**Interfaces:**
- Consumes: `SyncResult` with `syncedThroughPage` / `totalPages` (Task 1).
- Produces:
  - `export type SyncTrigger = 'scheduled' | 'manual'`
  - `export interface LastSyncRecord` exactly as in the spec §1 (`schemaVersion: 1`, `outcome`, `trigger`, `at`, `pagesFetched`, `count?`, `error?`, `consecutiveFailures`, `lastHealthyAt: string | null`).
  - `export const lastOutcomeKey = (userId: string) => \`collection:sync:lastOutcome:${userId}\``
  - `export async function recordSyncOutcome(kv: KVNamespace, numericId: string, result: SyncResult, trigger: SyncTrigger, now?: Date): Promise<void>`
  - `export async function readLastSyncRecord(kv: KVNamespace, numericId: string): Promise<LastSyncRecord | null>`: returns `null` for a missing key, unparseable JSON, or another `schemaVersion`; never throws.

- [ ] **Step 1: Write the failing tests** in `test/sync/lastOutcome.spec.ts` (clear `collection:` keys in `beforeEach`; pass a fixed `now`):
  - `starts a streak at 1 with no healthy run on a first failure`: `failed` → `consecutiveFailures: 1`, `lastHealthyAt: null`, `trigger: 'scheduled'`.
  - `increments the streak and carries lastHealthyAt forward across failures`: `completed` at T0, `failed` at T1, `crashed` at T2 → `consecutiveFailures: 2`, `lastHealthyAt: T0`.
  - `resets on completed, resumed, and skipped`: one case per outcome after a failing streak → `consecutiveFailures: 0`, `lastHealthyAt` equal to that run's `at`.
  - `counts token_invalid as a failure`.
  - `carries both counters unchanged for no_token and in_progress`.
  - `ignores a previous record with another schemaVersion` and `ignores a previous record that is not valid JSON` (put the raw string `'{nope'`): both behave as a first run.
  - `collapses whitespace and truncates the error to 500 characters`: error is `'HTTP 502: <html>\n  <body>' + 'x'.repeat(1000)`. Expect no `\n`, no double spaces, `error.length === 500`.
  - `sets a 30-day TTL`: pass a delegating KV wrapper with a `put` spy and assert it was called with `lastOutcomeKey(id)`, a string, and `{ expirationTtl: 2_592_000 }`.
  - `does not throw when the KV write fails`: wrapper whose `put` rejects; expect `recordSyncOutcome` to resolve and `console.warn` called once.

- [ ] **Step 2: Run** `npm test -- test/sync/lastOutcome.spec.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/sync/lastOutcome.ts`. Outcome classes as in spec §1: healthy `completed | resumed | skipped`; failing `failed | crashed | token_invalid`; neutral `no_token | in_progress`. `at = (now ?? new Date()).toISOString()`. Wrap the whole read-compute-write in `try`/`catch`; on error `console.warn` with the numericId and the error message only. Add a short comment that the read-modify-write is unguarded and last-writer-wins by design (spec §1 "Concurrency").

- [ ] **Step 4: Run** `npm test -- test/sync/lastOutcome.spec.ts`. Expected: PASS.

- [ ] **Step 5: Write the failing wiring tests.**
  - `test/sync/scheduled.spec.ts` `records the outcome for each user with trigger scheduled`: allowlist `gamma,alpha,beta`: `gamma` (token mirror; `mockImplementationOnce` rejecting with `HTTP 500` → `failed`), `alpha` (token mirror, default mock → `completed`), `beta` (no mirror → `no_token`). `mockImplementationOnce` replaces the next `DiscogsClient` construction and users run in allowlist order, so the failing user must come first. Read each with `readLastSyncRecord`; expect the outcomes and `trigger: 'scheduled'`. Extend the Task 2 revoked-token test to expect a `token_invalid` record.
  - `test/sync/scheduled.spec.ts` `records crashed when the sync throws outside its own error handling`: make the mocked `DiscogsClient` constructor throw for one user via `mockImplementationOnce(function () { throw new Error('ctor boom') })`. Expect a `crashed` record with `error: 'ctor boom'`.
  - `test/sync/refresh-collection-tool.spec.ts`:
    - `records a manual outcome`: after a default call, `readLastSyncRecord` returns `{ outcome: 'completed', trigger: 'manual' }`.
    - `includes syncedThroughPage and totalPages when the sync reports them`: progress at page 1 of 3 with page 1 stored; `searchCollection` rejects. Expect `syncedThroughPage: 1`, `totalPages: 3` in the tool JSON.
    - `records crashed and keeps throwing when the sync throws`: wrap `env.MCP_SESSIONS` for this server so `put` on `snapshotKey('12345')` throws; expect the handler call to reject with that error, and a `crashed` record with `trigger: 'manual'`. (Build the server with `{ ...env, MCP_SESSIONS: wrapped }`.)

- [ ] **Step 6: Run** them. Expected: FAIL.

- [ ] **Step 7: Implement the wiring.** `logSyncOutcome` keeps its `console.log` and then awaits `recordSyncOutcome(env.MCP_SESSIONS, numericId, result, 'scheduled')`. In `refresh_collection`, wrap the `syncCollection` call: on success await `recordSyncOutcome(..., 'manual')`; on a throw, await `recordSyncOutcome(..., { outcome: 'crashed', pagesFetched: 0, error: message }, 'manual')` and rethrow. Add `syncedThroughPage` and `totalPages` to the tool's JSON output with the same conditional-spread pattern used for `error`.

- [ ] **Step 8: Run** `npm test -- test/sync/`. Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/sync/types.ts src/sync/keys.ts src/sync/lastOutcome.ts src/index-oauth.ts src/mcp/tools/authenticated.ts test/sync/lastOutcome.spec.ts test/sync/scheduled.spec.ts test/sync/refresh-collection-tool.spec.ts
git commit -m "feat(sync): record the last sync outcome and failure streak per user (#89)"
```

---

### Task 4: Show the last sync outcome in `get_cache_stats`

**Files:**
- Create: `src/utils/age.ts`
- Modify: `src/rate-limiter/relay.ts` (import `describeAge` from `../utils/age`; drop the local definition)
- Modify: `src/sync/status.ts`
- Test: `test/utils/age.test.ts` (create; move the `describeAge` block out of `test/rate-limiter/relay.test.ts`), `test/sync/cache-stats-sync-state.spec.ts`

**Interfaces:**
- Consumes: `readLastSyncRecord` (Task 3).
- Produces: `export function describeAge(sinceMs: number, now: number): string` in `src/utils/age.ts`, same behaviour as today. `describeSyncState(kv: KVNamespace, numericId: string, now: number = Date.now()): Promise<string[]>`.

Exact lines (each array entry renders as one `•` bullet):

| Record | Lines appended after the existing snapshot/progress lines |
|---|---|
| none / unreadable | `Last sync: none recorded yet` |
| any | `Last sync: <label>, <trigger>, <age>` where trigger is `scheduled` or `manual refresh` |
| `consecutiveFailures > 0` | `Failures in a row: <n>; last healthy run <age or "not recorded yet">` |
| `error` present | `Error: <error>` |
| failing outcome and `error` contains `HTTP 429` | `Discogs is throttling requests from this Worker's IP. If this keeps happening, route Discogs calls through your own IP (README: "Route Discogs calls through your own IP"); ping shows the current egress.` |

Labels: `completed` → `completed`; `resumed` → `completed (resumed a partial sweep)`; `skipped` → `skipped (no changes)`; `failed` → `FAILED`; `crashed` → `CRASHED`; `token_invalid` → `FAILED (Discogs rejected the stored token; sign in again)`; `no_token` → `not run (no stored Discogs token; sign in once to enable background sync)`; `in_progress` → `in progress`.

- [ ] **Step 1: Move the `describeAge` test** to `test/utils/age.test.ts` importing from `../../src/utils/age`, with the ABOUTME header; remove it and its import from `relay.test.ts`.

- [ ] **Step 2: Write the failing tests** in `cache-stats-sync-state.spec.ts`. Seed records with `recordSyncOutcome` or a direct `put` of a `LastSyncRecord`; set `at` and `lastHealthyAt` relative to `Date.now()` so ages are deterministic at the coarse units (`2 h ago`, `14 d ago`):
  - `reports no record yet` → contains `Last sync: none recorded yet`.
  - `reports a healthy skipped run` → contains `Last sync: skipped (no changes), scheduled, 2 h ago`; does not contain `Failures in a row`.
  - `reports a failing streak with the last healthy run and the error` → `consecutiveFailures: 9`, `lastHealthyAt` 14 days ago, `error: 'HTTP 500: boom'`. Contains `Last sync: FAILED, scheduled, 2 h ago`, `Failures in a row: 9; last healthy run 14 d ago`, `Error: HTTP 500: boom`; does not contain `throttling`.
  - `says when no healthy run was ever recorded` → contains `last healthy run not recorded yet`.
  - `adds the relay hint for a 429 failure` → error contains `HTTP 429`; contains `route Discogs calls through your own IP`.
  - `omits the error line when a failure has no message` → does not contain `Error:`.
  - `treats an unreadable record as none` → put `'{nope'` at `lastOutcomeKey('12345')`; contains `Last sync: none recorded yet`.
  - `labels a manual refresh` → contains `, manual refresh, `.

- [ ] **Step 3: Run** `npm test -- test/sync/cache-stats-sync-state.spec.ts test/utils/age.test.ts test/rate-limiter/relay.test.ts`. Expected: FAIL (`src/utils/age.ts` missing; no `Last sync` lines).

- [ ] **Step 4: Implement** `src/utils/age.ts`, repoint `relay.ts`, and extend `describeSyncState`. The caller in `get_cache_stats` keeps calling it with two arguments.

- [ ] **Step 5: Run** `npm test`. Expected: all PASS (including the MCP catalogue snapshot, which is untouched because no tool description changed).

- [ ] **Step 6: Commit**

```bash
git add src/utils/age.ts src/rate-limiter/relay.ts src/sync/status.ts test/utils/age.test.ts test/rate-limiter/relay.test.ts test/sync/cache-stats-sync-state.spec.ts
git commit -m "feat(stats): show the last sync outcome and failure streak in get_cache_stats (#89)"
```

---

### Task 5: Name missing relay credentials

**Files:**
- Modify: `src/rate-limiter/relay.ts`
- Modify: `src/rate-limiter/durable-object.ts` (constructor log, `relayStatus()`)
- Test: `test/rate-limiter/relay.test.ts`, `test/rate-limiter/durable-object.test.ts`

**Interfaces:**
- Produces:
  - `export function missingRelayCredentials(env: RelayEnv): string[]`: `[]` when `DISCOGS_RELAY_ORIGIN` is unset or blank after trim; otherwise the names, in order, of `RELAY_ACCESS_CLIENT_ID` and `RELAY_ACCESS_CLIENT_SECRET` that are unset or blank after trim.
  - `RelayStatus.missingCredentials?: string[]` (optional so a status from an older DO reads as `[]`).

Exact copy, where `<names>` is the list joined with ` and `, and `<verb>` / `<pronoun>` are `is` / `it` for one name and `are` / `them` for two:
- `describeRelayStatus`: `Discogs egress: direct from Cloudflare. The relay is NOT active: DISCOGS_RELAY_ORIGIN is set but <names> <verb> missing. Set <pronoun> with wrangler secret put.`
- DO constructor: `console.warn('[RL] Egress relay OFF: DISCOGS_RELAY_ORIGIN is set but <names> <verb> missing')`, in place of the plain "relay off" line when the list is non-empty.

- [ ] **Step 1: Write the failing tests** in `relay.test.ts`:
  - `missingRelayCredentials`: `[]` for `{}`; `[]` for `{ DISCOGS_RELAY_ORIGIN: '  ', RELAY_ACCESS_CLIENT_ID: 'id', RELAY_ACCESS_CLIENT_SECRET: 'shh' }`; `['RELAY_ACCESS_CLIENT_SECRET']` for origin + id; `['RELAY_ACCESS_CLIENT_ID', 'RELAY_ACCESS_CLIENT_SECRET']` for origin only; `['RELAY_ACCESS_CLIENT_ID']` for origin + `RELAY_ACCESS_CLIENT_ID: ' '` + secret; `[]` when all three are set.
  - `describeRelayStatus` `names a single missing credential`: `{ enabled: false, origin: null, lastFallbackAt: null, fallbacks: 0, missingCredentials: ['RELAY_ACCESS_CLIENT_SECRET'] }` → the exact single-name sentence.
  - `names both missing credentials` → the exact two-name sentence.
  - `does not leak a secret value`: build the status from `missingRelayCredentials({ DISCOGS_RELAY_ORIGIN: 'https://r.example.com', RELAY_ACCESS_CLIENT_ID: 'id-value-123' })`; the line contains `RELAY_ACCESS_CLIENT_SECRET` and not `id-value-123`.
  - Existing `reports direct egress when no relay is configured` (no `missingCredentials` field) still returns `Discogs egress: direct from Cloudflare (no relay configured)`.
  - In `durable-object.test.ts`, `reports missingCredentials through /state`: `const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('state-test'))`, fetch `http://do/state`, expect `body.relay.missingCredentials` toEqual `[]` (the test env has no relay origin).

- [ ] **Step 2: Run** `npm test -- test/rate-limiter/`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add `missingRelayCredentials`; store its result on the DO in the constructor next to `this.relay`; return it from `relayStatus()`; check it first in `describeRelayStatus`. Correct the `relayConfigFrom` doc comment so it points at `missingRelayCredentials` and the constructor warning.

- [ ] **Step 4: Run** `npm test -- test/rate-limiter/`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rate-limiter/relay.ts src/rate-limiter/durable-object.ts test/rate-limiter/relay.test.ts test/rate-limiter/durable-object.test.ts
git commit -m "fix(relay): name the missing relay credential instead of silently going direct (#89)"
```

---

### Task 6: README and `wrangler.toml`

**Files:**
- Modify: `README.md` ("Let a coding agent set it up" step 8; "Collection size and the free plan"; "Route Discogs calls through your own IP"; "Diagnostics")
- Modify: `wrangler.toml` (comment above the top-level `DISCOGS_RELAY_ORIGIN`)

Content is fixed by spec §5. Points the builder needs that the spec doesn't spell out:
- Verified 2026-11-09 against the [Wrangler configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/) and [Secrets docs](https://developers.cloudflare.com/workers/configuration/secrets/): plain variables set in the dashboard are overwritten by the next deploy unless `keep_vars = true` (config) or `--keep-vars` (CLI); `wrangler deploy` never deletes secrets.
- Keep "Discogs throttles by source IP" as the README already words it; don't add numbers the issue didn't measure.
- The relay contract is a short bulleted list; the two setups follow it as two short paragraphs. Credit "#89" with a link for the VPS proxy, not a vendor endorsement.
- Follow `/Users/rian/git/product-ai/01-context/avoid-ai-patterns.md` for wording.

- [ ] **Step 1: Edit** `README.md` and `wrangler.toml` per spec §5.
- [ ] **Step 2: Verify** `npm run format:check` passes, and `grep -n "keep_vars\|missing\|get_cache_stats" README.md` shows the placement note, the missing-credential sentence, and the last-sync mention in "Diagnostics" and "Collection size and the free plan".
- [ ] **Step 3: Commit**

```bash
git add README.md wrangler.toml
git commit -m "docs: present the relay as the fix for shared-IP throttling and note where its values live (#89)"
```

---

### Task 7: Verify the branch and open the PR

- [ ] **Step 1: Run** `npm run lint && npm run format:check && npm test && npm run build`. Expected: all pass, test output has no warnings or unexpected errors.
- [ ] **Step 2: Push** `git push -u origin fix/issue-89-sync-relay-diagnostics`.
- [ ] **Step 3: Open the PR** with `gh pr create`: title `Make sync failures and relay misconfiguration visible (#89)`; body summarises the five changes, states that the longer cron backoff and `server_info` sync status were deliberately left out (see the spec's Non-goals), says `Refs #89` (not `Closes`, since the reply comes after review), and ends with the attribution line. Note in the body that merging to `main` auto-deploys production via CI.
- [ ] **Step 4: Link the PR** to this thread.
- [ ] **Step 5: Draft the #89 reply** (not posted): thanks, what shipped with the PR link, why the cron-backoff and `server_info` suggestions weren't taken, and the upgrade note from v3.5.0 (#84 sends OAuth sign-in through the relay; #56 and #57 fixed the free-plan sync). Show it to Rian before posting.

Release (version bump in `src/version.ts`, GitHub release notes) is a separate step after merge and is not part of this plan.
