# Discogs MCP Server Modernization Plan

> **📍 CURRENT STATUS (2025-12-14)**
> **Sessions Complete:** 1 (Setup) ✅ | 2 (Public Tools) ✅
> **Next Session:** 3 (Authenticated Tools) 🟡
> **Branch:** `feature/agents-sdk-migration`
> **Progress:** 2/8 sessions complete (25%)

## Executive Summary

The Discogs MCP server currently uses a **custom hand-rolled MCP implementation** built directly on Cloudflare Workers, predating the official Cloudflare Agents SDK and the latest MCP specification (2025-11-25).

**Decision**: Migrate to the **Cloudflare Agents SDK** using `createMcpHandler` with the official `@modelcontextprotocol/sdk` for automatic spec compliance, official support, and reduced maintenance burden.

**Inspiration**: This plan follows the successful pattern from the Last.fm MCP migration (completed 2025-12-10), adapted for Discogs-specific requirements.

---

## Current State

### What We Have

| File | Purpose | Keep/Migrate/Remove |
|------|---------|---------------------|
| `src/index.ts` | Main worker entry, routing | **Migrate** - simplify to use SDK |
| `src/protocol/handlers.ts` | MCP method handlers (1773 lines) | **Migrate** - convert to SDK tools/resources |
| `src/protocol/parser.ts` | JSON-RPC parsing | **Remove** - SDK handles this |
| `src/protocol/validation.ts` | Request validation | **Remove** - SDK + Zod handles this |
| `src/types/mcp.ts` | MCP type definitions | **Remove** - SDK provides types |
| `src/types/jsonrpc.ts` | JSON-RPC 2.0 types | **Remove** - SDK provides types |
| `src/transport/sse.ts` | Legacy SSE transport | **Remove** - deprecated |
| `src/auth/discogs.ts` | Discogs OAuth 1.0a | **Keep** - still needed |
| `src/auth/jwt.ts` | JWT session management | **Keep** - still needed |
| `src/clients/discogs.ts` | Discogs API client | **Keep** - still needed |
| `src/clients/cachedDiscogs.ts` | Cached API client | **Keep** - still needed |
| `src/utils/moodMapping.ts` | Mood-to-genre mapping | **Keep** - unique business logic! |
| `src/utils/cache.ts` | Cache utilities | **Keep** - still needed |
| `src/utils/rateLimit.ts` | Rate limiting | **Keep** - still needed |
| `src/utils/retry.ts` | Retry logic | **Keep** - still needed |
| `src/utils/kvLogger.ts` | KV logging | **Keep** - still needed |

### What's Working (Keep These)

- ✅ Discogs API client with sophisticated search logic
- ✅ **Mood mapping system** (unique feature - maps emotional descriptors to genres)
- ✅ Discogs OAuth 1.0a authentication flow
- ✅ JWT session management
- ✅ Multi-tier caching with request deduplication
- ✅ Dual-window rate limiting (per-minute + per-hour)
- ✅ Retry logic with exponential backoff
- ✅ KV storage for sessions, caching, rate limits, logs

### What's Being Replaced

- ❌ Custom JSON-RPC parsing → SDK handles
- ❌ Custom protocol validation → Zod schemas
- ❌ Custom MCP type definitions → SDK provides
- ❌ Custom transport handling → `createMcpHandler`
- ❌ Legacy SSE endpoint → Streamable HTTP only
- ❌ 1773-line protocol handlers file → Clean SDK tool registration

---

## Target Architecture

### New Code Structure

```
src/
├── index.ts                    # Main entry - routes + createMcpHandler
├── mcp/
│   ├── server.ts               # McpServer configuration
│   ├── tools/
│   │   ├── index.ts            # Tool registration
│   │   ├── public.ts           # ping, server_info, auth_status
│   │   └── authenticated.ts    # search, stats, recommendations, etc.
│   ├── resources/
│   │   └── discogs.ts          # Resource templates
│   └── prompts/
│       └── collection.ts       # Prompt definitions
├── auth/
│   ├── discogs.ts              # Discogs OAuth 1.0a (existing)
│   └── jwt.ts                  # JWT sessions (existing)
├── clients/
│   ├── discogs.ts              # Discogs API (existing)
│   └── cachedDiscogs.ts        # Cached client (existing)
├── utils/
│   ├── moodMapping.ts          # Mood-to-genre mapping (existing - PRESERVE!)
│   ├── cache.ts                # Caching utilities (existing)
│   ├── rateLimit.ts            # Rate limiting (existing)
│   ├── retry.ts                # Retry logic (existing)
│   └── kvLogger.ts             # Logging (existing)
└── types/
    └── env.ts                  # Environment types (existing)
```

### Endpoint Structure

| Endpoint | Method | Purpose | Notes |
|----------|--------|---------|-------|
| `/` | GET | Server info JSON | Simple metadata |
| `/` | POST | MCP JSON-RPC | **Keep for backward compat** |
| `/mcp` | POST | MCP JSON-RPC | Primary endpoint going forward |
| `/mcp` | GET | SSE stream (optional) | SDK handles this if needed |
| `/login` | GET | Discogs OAuth redirect | |
| `/callback` | GET | Discogs OAuth callback | |
| `/mcp-auth` | GET | Auth status endpoint | |
| `/health` | GET | Health check | |

### Breaking Changes

| Change | Impact | Mitigation |
|--------|--------|------------|
| `/sse` endpoint removed | Users with `/sse` in config | Low impact - most use root or `/mcp` |
| `POST /` still works | None | Keeping for backward compat |
| Protocol internals | None visible to users | SDK handles same JSON-RPC format |

---

## Migration Checklist

Use this checklist across multiple coding sessions. Check off items as completed.

### Session 1: Setup & Dependencies ✅ COMPLETE

- [x] **1.1** Create feature branch: `git checkout -b feature/agents-sdk-migration`
- [x] **1.2** Install dependencies:
  ```bash
  npm install agents @modelcontextprotocol/sdk zod
  ```
  - Installed: agents@0.2.32, @modelcontextprotocol/sdk@1.24.3, zod@4.1.13
- [x] **1.3** Verify dependencies work with Cloudflare Workers
  - Added `nodejs_compat` to compatibility_flags in wrangler.toml
- [x] **1.4** Create `src/mcp/` directory structure
  - Created: tools/, resources/, prompts/ subdirectories
- [x] **1.5** Create basic `src/mcp/server.ts` with empty McpServer
  - Implemented factory pattern: `createServer(env)`
- [x] **1.6** Test that worker still builds: `npm run build`
  - Build successful (2597 KiB bundle size)

### Session 2: Public Tools Migration ✅ COMPLETE

- [x] **2.1** Create `src/mcp/tools/public.ts`
- [x] **2.2** Migrate `ping` tool with Zod schema
  - Optional `message` parameter with default value
- [x] **2.3** Migrate `server_info` tool
  - Returns server info and authentication URL
- [x] **2.4** Migrate `auth_status` tool
  - Simplified to not require Request object (SDK limitation)
- [x] **2.5** Register all public tools in `src/mcp/server.ts`
  - Updated index.ts to use `createMcpHandler`
  - Routes: POST /mcp (primary), POST / (backward compat)
- [x] **2.6** Write/update tests for public tools
  - Manual testing completed via curl
- [x] **2.7** Test with MCP Inspector (public tools only)
  - All 3 tools tested and working: ping, server_info, auth_status

### Session 3: Authenticated Tools Migration

- [ ] **3.1** Create `src/mcp/tools/authenticated.ts`
- [ ] **3.2** Implement session/auth context passing to tools
- [ ] **3.3** Migrate `search_collection` tool (with mood mapping!)
- [ ] **3.4** Migrate `get_release` tool
- [ ] **3.5** Migrate `get_collection_stats` tool
- [ ] **3.6** Migrate `get_recommendations` tool (with mood support!)
- [ ] **3.7** Migrate `get_recent_activity` tool
- [ ] **3.8** Migrate `get_cache_stats` tool
- [ ] **3.9** Register all authenticated tools
- [ ] **3.10** Ensure mood mapping logic is preserved
- [ ] **3.11** Write/update tests for authenticated tools

### Session 4: Resources & Prompts Migration

- [ ] **4.1** Create `src/mcp/resources/discogs.ts`
- [ ] **4.2** Migrate `discogs://collection` resource
- [ ] **4.3** Migrate `discogs://release/{id}` resource
- [ ] **4.4** Migrate `discogs://search?q={query}` resource
- [ ] **4.5** Register resources in server
- [ ] **4.6** Create `src/mcp/prompts/collection.ts`
- [ ] **4.7** Migrate `browse_collection` prompt
- [ ] **4.8** Migrate `find_music` prompt
- [ ] **4.9** Migrate `collection_insights` prompt
- [ ] **4.10** Register prompts in server
- [ ] **4.11** Test resources and prompts

### Session 5: Main Entry Point & Routing

- [ ] **5.1** Update `src/index.ts` to use `createMcpHandler`
- [ ] **5.2** Keep `/` GET for server info JSON
- [ ] **5.3** Route `/mcp` to `createMcpHandler`
- [ ] **5.4** Keep backward compat: `POST /` also routes to MCP
- [ ] **5.5** Keep `/login`, `/callback` for OAuth flow
- [ ] **5.6** Keep `/mcp-auth` endpoint
- [ ] **5.7** Keep `/health` endpoint
- [ ] **5.8** Integrate session management with SDK
- [ ] **5.9** Integrate rate limiting
- [ ] **5.10** Test full request flow locally

### Session 6: Authentication Integration

- [ ] **6.1** Ensure OAuth 1.0a flow works with new structure
- [ ] **6.2** Test session persistence across MCP requests
- [ ] **6.3** Test unauthenticated → authenticated flow
- [ ] **6.4** Verify session handling (cookie + connection-specific)
- [ ] **6.5** Test with MCP Inspector
- [ ] **6.6** Test with Claude Desktop (if available)

### Session 7: Testing & Validation

- [ ] **7.1** Run full test suite: `npm test`
- [ ] **7.2** Test with MCP Inspector (all features)
- [ ] **7.3** Test with Claude Code/Desktop
- [ ] **7.4** Verify all tools work
- [ ] **7.5** Verify all resources work
- [ ] **7.6** Verify all prompts work
- [ ] **7.7** Verify authentication flow end-to-end
- [ ] **7.8** Verify mood mapping still works in searches/recommendations
- [ ] **7.9** Performance testing (rate limits, caching)
- [ ] **7.10** Multi-user testing

### Session 8: Cleanup & Deployment

- [ ] **8.1** Remove old files:
  - [ ] `src/protocol/handlers.ts`
  - [ ] `src/protocol/parser.ts`
  - [ ] `src/protocol/validation.ts`
  - [ ] `src/transport/sse.ts`
  - [ ] `src/types/mcp.ts`
  - [ ] `src/types/jsonrpc.ts`
- [ ] **8.2** Remove unused dependencies (`crypto-js`, `oauth-1.0a` if replaced)
- [ ] **8.3** Update README.md with new architecture
- [ ] **8.4** Update documentation with new client configs
- [ ] **8.5** Run linting: `npm run lint`
- [ ] **8.6** Run formatting: `npm run format`
- [ ] **8.7** Final test suite run
- [ ] **8.8** Deploy to development: `npm run deploy`
- [ ] **8.9** Test development deployment
- [ ] **8.10** Deploy to production: `npm run deploy:prod`
- [ ] **8.11** Verify production deployment
- [ ] **8.12** Merge PR to main

---

## Code Examples

### Basic Server Setup

```typescript
// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const server = new McpServer({
  name: "discogs-mcp",
  version: "1.0.0",
});

// Import and register tools, resources, prompts
import { registerPublicTools } from "./tools/public.js";
import { registerAuthenticatedTools } from "./tools/authenticated.js";
import { registerResources } from "./resources/discogs.js";
import { registerPrompts } from "./prompts/collection.js";

registerPublicTools(server);
registerAuthenticatedTools(server);
registerResources(server);
registerPrompts(server);
```

### Tool Registration Example (with Mood Mapping)

```typescript
// src/mcp/tools/authenticated.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandMoodToGenres } from "../../utils/moodMapping.js";

export function registerAuthenticatedTools(server: McpServer, env: Env) {
  server.tool(
    "search_collection",
    "Search your Discogs collection with mood-aware queries",
    {
      query: z.string().describe("Search query (supports mood descriptors like 'mellow jazz' or 'energetic')"),
      limit: z.number().optional().default(20),
    },
    async ({ query, limit }, { sessionId }) => {
      // Get authenticated client from session
      const client = await getAuthenticatedClient(sessionId, env);

      // Apply mood mapping to enhance query
      const moodMatch = expandMoodToGenres(query);
      const enhancedQuery = moodMatch.confidence >= 0.3
        ? { ...parseQuery(query), genres: moodMatch.genres }
        : parseQuery(query);

      const results = await client.searchCollection(enhancedQuery, limit);

      return {
        content: [{
          type: "text",
          text: formatSearchResults(results),
        }],
      };
    }
  );

  server.tool(
    "get_recommendations",
    "Get personalized music recommendations with mood support",
    {
      mood: z.string().optional().describe("Mood descriptor (e.g., 'mellow', 'energetic', 'Sunday evening')"),
      genre: z.string().optional(),
      decade: z.string().optional(),
      similar_to: z.string().optional().describe("Release ID to find similar music"),
      limit: z.number().optional().default(10),
    },
    async ({ mood, genre, decade, similar_to, limit }, { sessionId }) => {
      const client = await getAuthenticatedClient(sessionId, env);

      // Enhance mood queries with genre expansion
      let filters: any = { genre, decade, similar_to };
      if (mood) {
        const moodMatch = expandMoodToGenres(mood);
        if (moodMatch.confidence >= 0.3) {
          filters.moodGenres = moodMatch.genres;
          filters.moodContext = moodMatch.context;
        }
      }

      const recommendations = await client.getRecommendations(filters, limit);

      return {
        content: [{
          type: "text",
          text: formatRecommendations(recommendations),
        }],
      };
    }
  );
}
```

### Main Entry Point

```typescript
// src/index.ts
import { createMcpHandler } from "agents/mcp";
import { server } from "./mcp/server.js";
import type { Env } from "./types/env.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // MCP endpoint - primary (/mcp) and backward compat (POST /)
    if (url.pathname === "/mcp" || (url.pathname === "/" && request.method === "POST")) {
      return createMcpHandler(server)(request, env, ctx);
    }

    // Server info (GET / only)
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(JSON.stringify({
        name: "discogs-mcp",
        version: "1.0.0",
        description: "Discogs MCP server with mood-aware music discovery",
        endpoints: {
          mcp: "/mcp",
          login: "/login",
          health: "/health"
        }
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Auth endpoints (keep existing)
    if (url.pathname === "/login") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }
    if (url.pathname === "/mcp-auth") {
      return handleMCPAuth(request, env);
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

---

## Known Challenges & Solutions

### Challenge 1: Passing Environment to Tools

The SDK's `server.tool()` doesn't directly receive `env`. Solutions:

**Recommended: Factory function approach**

```typescript
// src/mcp/server.ts
export function createServer(env: Env) {
  const server = new McpServer({ name: "discogs-mcp", version: "1.0.0" });

  // Create clients with env access via closure
  const discogsClient = new DiscogsClient(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET);
  const cachedClient = new CachedDiscogsClient(discogsClient, env.MCP_SESSIONS);

  // Register tools with access to clients via closure
  registerPublicTools(server);
  registerAuthenticatedTools(server, env, cachedClient);
  registerResources(server, env);
  registerPrompts(server, env);

  return server;
}
```

### Challenge 2: OAuth 1.0a Authentication

Discogs uses OAuth 1.0a (not 2.0), which requires HMAC-SHA1 signatures.

**Current implementation to preserve:**
- `src/auth/discogs.ts` - OAuth 1.0a with Web Crypto API
- Three-step flow: Request Token → User Authorization → Access Token
- HMAC-SHA1 signature generation
- Request throttling (200ms delay)

**Integration with SDK:**
- Keep OAuth flow in separate endpoints (`/login`, `/callback`)
- Store access tokens in sessions (KV storage)
- Pass session ID via cookie or query parameter
- Tools retrieve auth context from session storage

### Challenge 3: Preserving Mood Mapping Logic

The mood mapping system (`src/utils/moodMapping.ts`) is unique business logic that must be preserved.

**Key features to maintain:**
- Emotional descriptor → genre/style mapping
- Contextual mappings (time, activity, season)
- Compound mood detection
- Confidence scoring
- Concrete genre filtering

**Integration approach:**
```typescript
// Import mood mapping in tool handlers
import { expandMoodToGenres } from "../../utils/moodMapping.js";

// Apply in search_collection and get_recommendations tools
const moodMatch = expandMoodToGenres(query);
if (moodMatch.confidence >= 0.3) {
  // Enhance query with mood-derived genres
}
```

### Challenge 4: Session Management

**Current multi-strategy approach:**
- Cookie-based sessions (HTTP-only, Secure, SameSite=Lax)
- Connection-specific sessions for SSE compatibility
- Deterministic connection IDs for mcp-remote

**Migration strategy:**
- Simplify to cookie-based sessions only (SSE deprecated)
- Use SDK's session handling if available
- Fall back to manual session lookup via `Mcp-Session-Id` header

---

## Discogs-Specific Considerations

### OAuth 1.0a vs OAuth 2.0

Unlike Last.fm MCP (which uses OAuth 2.0), Discogs requires OAuth 1.0a:
- More complex signature requirements (HMAC-SHA1)
- Three-legged authentication flow
- Token + Token Secret pairs
- No refresh tokens (tokens don't expire)

**Preservation strategy:**
- Keep `src/auth/discogs.ts` implementation
- Keep `crypto-js` and `oauth-1.0a` dependencies
- Maintain current OAuth endpoints (`/login`, `/callback`)

### Mood Mapping Intelligence

The mood mapping system is a key differentiator:
- Maps queries like "mellow Sunday evening jazz" to concrete genres
- Handles temporal contexts ("rainy day", "dinner music")
- Provides confidence scores to avoid false positives

**Testing priorities:**
1. Verify mood detection accuracy
2. Test contextual mappings
3. Ensure confidence thresholds work correctly
4. Validate genre expansion logic

### Advanced Search Logic

The search implementation has sophisticated features:
- OR logic for genre queries
- AND logic for specific term searches
- Relevance scoring with term match percentage
- Temporal sorting ("recent", "latest")
- Decade expansion ("1960s" → 1960-1969)

**Preservation checklist:**
- Multi-word query handling
- Relevance scoring algorithm
- Temporal term detection
- Decade range expansion

---

## Progress Tracking

Use this section to track progress across sessions:

| Session | Status | Date | Notes |
|---------|--------|------|-------|
| 1. Setup & Dependencies | ✅ Complete | 2025-12-14 | Installed SDK, created directory structure, added nodejs_compat flag |
| 2. Public Tools | ✅ Complete | 2025-12-14 | Migrated 3 public tools, integrated createMcpHandler, all tools tested |
| 3. Authenticated Tools | 🟡 **START HERE** | | **Next session**: Migrate 6 authenticated tools with session management |
| 4. Resources & Prompts | ⬜ Not Started | | |
| 5. Entry Point & Routing | ✅ Partially Done | 2025-12-14 | MCP routing complete, auth endpoints preserved |
| 6. Authentication | ⬜ Not Started | | Need to integrate session management with SDK context |
| 7. Testing | ⬜ Not Started | | |
| 8. Cleanup & Deploy | ⬜ Not Started | | |

Legend: ⬜ Not Started | 🟡 In Progress | ✅ Complete | ❌ Blocked

### Key Findings & Notes

**Session 1 & 2 Learnings:**
- ✅ SDK requires `nodejs_compat` compatibility flag in wrangler.toml
- ✅ Bundle size increased from 147 KiB → 2597 KiB (expected with full SDK)
- ⚠️ SDK tool handlers don't receive Request object in `extra` parameter
- ⚠️ Need to find alternative way to access request context for session management
- ✅ Factory pattern (`createServer(env)`) works well for env access
- ✅ SSE-style responses work (event: message / data: format)
- ✅ Backward compatibility maintained (POST / still works)

**Next Steps for Session 3:**
1. Investigate how to pass session/auth context to authenticated tools
2. Consider using middleware or context storage for session management
3. Migrate 6 authenticated tools with mood mapping preservation
4. Test authenticated tool flow (even without full auth working yet)

---

## Testing Strategy

### Unit Tests
- All tools with mocked Discogs API
- Mood mapping function tests
- Search logic validation
- Recommendation algorithm tests

### Integration Tests
- Full OAuth 1.0a flow
- Session persistence
- Rate limiting under load
- Cache hit/miss ratios

### Mood Mapping Tests (Critical!)
```typescript
describe('Mood Mapping', () => {
  test('detects mellow mood', () => {
    const result = expandMoodToGenres('mellow jazz');
    expect(result.confidence).toBeGreaterThanOrEqual(0.3);
    expect(result.genres).toContain('Jazz');
  });

  test('handles contextual moods', () => {
    const result = expandMoodToGenres('Sunday evening vibes');
    expect(result.context).toBe('time');
    expect(result.genres.length).toBeGreaterThan(0);
  });
});
```

### Client Compatibility
- MCP Inspector
- Claude Code
- Claude Desktop
- Windsurf (if supported)

---

## Client Configuration Reference

After migration, update documentation with these configs:

### Claude Code

```bash
claude mcp add --transport http discogs https://discogs-mcp-prod.WORKER_NAME.workers.dev/mcp
```

### Claude Desktop (Connectors UI)

1. Open Claude Desktop → Settings → Connectors
2. Click "Add Connector"
3. Enter: `https://discogs-mcp-prod.WORKER_NAME.workers.dev/mcp`
4. Click "Add"

### Claude Desktop (Config File with mcp-remote)

```json
{
  "mcpServers": {
    "discogs": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://discogs-mcp-prod.WORKER_NAME.workers.dev/mcp"]
    }
  }
}
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector https://discogs-mcp-prod.WORKER_NAME.workers.dev/mcp
```

---

## References

- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-03-26) - Latest MCP spec
- [Cloudflare Agents SDK - createMcpHandler](https://developers.cloudflare.com/agents/model-context-protocol/mcp-handler-api/)
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) - Official TypeScript SDK
- [TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [Last.fm MCP Migration Plan](../lastfm-mcp/docs/MCP-MODERNIZATION-PLAN.md) - Reference implementation

---

## Success Criteria

Migration is complete when:
1. ✅ All 9 tools working with SDK
2. ✅ All 3 resources working with SDK
3. ✅ All 3 prompts working with SDK
4. ✅ OAuth 1.0a authentication flow preserved
5. ✅ Mood mapping system fully functional
6. ✅ All tests passing
7. ✅ Deployed to production
8. ✅ Backward compatibility maintained (POST / still works)
9. ✅ Client configuration docs updated
10. ✅ Old custom protocol code removed
