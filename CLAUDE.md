# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Discogs MCP — a Cloudflare Workers MCP server that lets AI assistants interact with users' Discogs music collections. Implements OAuth 1.0a authentication against the Discogs API, intelligent search with mood mapping, and context-aware recommendations. Deployed at discogs-mcp.com (locked to maintainer; users must self-host).

## Commands

```bash
npm run dev              # Local dev server on port 8787
npm run build            # Dry-run build (wrangler deploy --dry-run)
npm test                 # Vitest with Cloudflare Workers pool
npm test -- path/to/file # Single test file
npm test -- --watch      # Watch mode
npm run lint             # ESLint (must pass before every commit)
npm run format           # Prettier --write
npm run format:check     # Prettier --check
npm run deploy           # Deploy to dev environment
npm run deploy:prod      # Deploy to production
npm run cf-typegen       # Regenerate Cloudflare Workers types
```

## Architecture

Entry point: `src/index-oauth.ts` — routes requests through `OAuthProvider` which handles OAuth endpoints, then delegates MCP traffic to the server created by `src/mcp/server.ts`.

```
src/
├── auth/              # OAuth 1.0a flow (Discogs) + JWT session tokens
├── clients/           # DiscogsClient (API calls + retry) → CachedDiscogsClient (KV cache wrapper)
├── mcp/
│   ├── server.ts      # MCP server factory — registers all tools, resources, prompts
│   ├── tools/
│   │   ├── public.ts          # Unauthenticated: ping, server_info, auth_status
│   │   └── authenticated.ts   # Requires auth: search_collection, search_discogs, get_release, etc.
│   ├── resources/     # MCP resource definitions
│   └── prompts/       # MCP prompt templates
├── rate-limiter/      # Durable Object for coordinated rate limiting across Workers
├── types/             # Shared TypeScript types
├── utils/
│   ├── moodMapping.ts         # Maps emotional descriptors ("mellow", "Sunday vibes") → genres/styles
│   ├── searchRanking.ts       # Deduplication, scoring, ranking of search results
│   ├── searchQueryParser.ts   # Classifies queries (mood, specific, genre, etc.)
│   ├── cache.ts               # KV-based caching utilities
│   └── kvLogger.ts            # Structured logging to KV
└── marketing-page.ts  # HTML landing page
```

### Key patterns

- **Request context injection**: MCP server injects auth context before each tool handler call — tools receive the authenticated user's Discogs client
- **Two-layer caching**: CachedDiscogsClient wraps DiscogsClient; cache keys in KV with TTLs to stay within Discogs' 60 req/min rate limit
- **Rate limiting via Durable Objects**: `src/rate-limiter/durable-object.ts` coordinates rate limits across Worker instances
- **Mood intelligence**: `moodMapping.ts` converts emotional/situational descriptors into genre and style filters — core differentiator of the search experience
- **OAuth dance**: Discogs uses OAuth 1.0a (not 2.0); `oauth-1.0a` library signs requests. The Workers OAuth Provider wraps this with OAuth 2.1 for MCP clients

### Infrastructure

- **Runtime**: Cloudflare Workers (ES2021 target, Node.js compat enabled)
- **Storage**: KV namespaces for sessions (`MCP_SESSIONS`) and OAuth state (`OAUTH_KV`); sync outcomes structured-log to console (Workers Observability)
- **Durable Objects**: `DiscogsRateLimiter` class
- **Secrets** (via `wrangler secret put`): `DISCOGS_CONSUMER_KEY`, `DISCOGS_CONSUMER_SECRET`, `JWT_SECRET`
- **CI**: GitHub Actions — lint → test → build → auto-deploy to prod on main push

## Code conventions

- **ABOUTME comments**: Every code file starts with a 2-line comment where each line begins with `ABOUTME: ` — explains what the file does
- **Formatting**: Prettier — 140 char width, single quotes, no semicolons, tabs
- **TypeScript**: Strict mode, explicit types, avoid `any` (ESLint warns)
- **Naming**: No temporal names like "improved", "new", "enhanced" — names must be evergreen
- **Evergreen comments**: Describe code as-is, never reference refactors or recent changes
- **Error handling**: Fail fast for programming errors, recover gracefully for user/external errors
- **Changes**: Make the smallest reasonable change. Never rewrite from scratch without explicit permission
- **Unrelated fixes**: Don't fix unrelated issues in a task — document them in `development/todo.md` with priority (P0/P1/P2)
- **Schema validation**: Zod for runtime validation of API responses and tool inputs

## Testing

- Framework: Vitest with `@cloudflare/vitest-pool-workers` — tests run in Workers-compatible environment
- Mock Discogs API responses for unit tests; real protocol compliance checks for integration tests
- Test output must be clean — no warnings, no unexpected errors in logs
- Tests live in `test/` mirroring `src/` structure
