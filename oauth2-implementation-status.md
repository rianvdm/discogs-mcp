# OAuth 2.1 Implementation Status

## Summary
We successfully implemented OAuth 2.1 with PKCE support for Claude Custom Integrations. The authentication flow works perfectly, but tools are not appearing in Claude after authentication.

## What's Working
1. **OAuth 2.1 Infrastructure**
   - ✅ Authorization Server Metadata endpoint (`/.well-known/oauth-authorization-server`)
   - ✅ Dynamic Client Registration (`/oauth/register`)
   - ✅ Authorization endpoint with PKCE (`/oauth/authorize`)
   - ✅ Token endpoint (`/oauth/token`)
   - ✅ Bearer token authentication in middleware

2. **Claude Integration Flow**
   - ✅ Claude detects authentication requirement (HTTP 401 on `initialize`)
   - ✅ Claude discovers OAuth endpoints
   - ✅ "Connect" button appears and OAuth flow completes
   - ✅ Claude successfully authenticates with Bearer token
   - ✅ Discogs access tokens are properly stored and retrieved

3. **Authentication**
   - ✅ Unified authentication middleware supporting both JWT and Bearer tokens
   - ✅ Bearer tokens include Discogs access tokens for API calls
   - ✅ Proper HTTP 401 responses for unauthenticated requests

## What's NOT Working
1. **Tool Discovery**
   - ❌ Claude never calls `tools/list` after authentication
   - ❌ Tools don't appear in Claude's UI
   - ❌ Manual tool invocation doesn't work

## Current Behavior
1. User adds `https://discogs-mcp-prod.rian-db8.workers.dev` to Claude Custom Integrations
2. Claude makes `initialize` request → gets HTTP 401
3. Claude discovers OAuth endpoints and shows "Connect" button
4. User completes OAuth flow with Discogs
5. Claude makes authenticated `initialize` request → succeeds
6. Claude sends `notifications/initialized`
7. **Claude stops here - no `tools/list` request**

## Debug Findings
- Claude uses `python-httpx/0.27.0` as User-Agent, not `claude-ai`
- Claude identifies itself as `claude-ai v0.1.0` in the MCP client info
- The OAuth flow completes with proper Bearer tokens containing Discogs access tokens
- No subsequent requests are made after successful initialization

## Possible Issues
1. **Protocol Mismatch**: Claude Custom Integrations might expect a different MCP flow
2. **Tool Advertisement**: Tools might need to be advertised differently (not via `tools/list`)
3. **Missing Configuration**: There might be additional OAuth or MCP requirements we haven't implemented
4. **Client Limitation**: Claude Custom Integrations might not fully support tool discovery yet

## Next Steps to Try
1. Test with MCP Inspector tool to validate our server implementation
2. Check if tools need to be included in the `initialize` response
3. Investigate if Claude expects a specific OAuth scope or token format
4. Check Claude's documentation for any updates on Custom Integrations
5. Test if the server works with other MCP clients

## Files Modified
- `src/auth/metadata.ts` - OAuth 2.1 Authorization Server Metadata
- `src/auth/registration.ts` - Dynamic Client Registration
- `src/auth/oauth2.ts` - OAuth 2.1 Authorization and Token endpoints
- `src/auth/middleware.ts` - Unified authentication middleware
- `src/index.ts` - Added OAuth routes and HTTP 401 handling
- `src/transport/sse.ts` - Added Bearer token support for SSE
- `src/protocol/handlers.ts` - Added Claude-specific authentication requirements
- `src/types/env.ts` - Added DISCOGS_OAUTH_CLIENTS and DISCOGS_OAUTH_TOKENS KV namespaces
- `wrangler.toml` - Added KV namespace configurations

## Technical Details
- All changes are in the `feature/oauth2-claude-custom-integrations` branch
- Tests are passing (216/216)
- Production deployment URL: https://discogs-mcp-prod.rian-db8.workers.dev
- KV namespaces created with DISCOGS_ prefix as requested

## Environment Variables Required
- `DISCOGS_CONSUMER_KEY` - Discogs OAuth consumer key
- `DISCOGS_CONSUMER_SECRET` - Discogs OAuth consumer secret  
- `JWT_SECRET` - JWT signing secret

## KV Namespaces Required
- `DISCOGS_OAUTH_CLIENTS` - Stores registered OAuth clients
- `DISCOGS_OAUTH_TOKENS` - Stores OAuth tokens and authorization codes
- `MCP_SESSIONS` - Existing session storage
- `MCP_LOGS` - Existing logging storage
- `MCP_RL` - Existing rate limiting storage