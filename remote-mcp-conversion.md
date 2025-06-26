# Remote MCP Conversion Analysis & Implementation Plan

## Overview

This document outlines the plan to add Claude Custom Integrations support to the existing Discogs MCP server. The goal is to enable the server to work with Claude.ai and Claude for Desktop through their remote MCP server integration feature.

## Current Architecture Analysis

### Existing Implementation
- **Transport**: Server-Sent Events (SSE) at `/sse` endpoint
- **Authentication**: OAuth 1.0a with Discogs + JWT sessions
- **Protocol**: Full MCP protocol implementation with tools, prompts, resources
- **Storage**: Cloudflare KV for sessions, logs, rate limiting
- **Deployment**: Cloudflare Workers with production/dev environments

### Current Authentication Flow
1. User visits `/login` → redirects to Discogs OAuth
2. Discogs callback → exchanges tokens → creates JWT session
3. JWT stored in HTTP-only cookie + KV storage
4. SSE connections authenticate via connection-specific sessions
5. MCP requests validated via JWT verification

## Claude Custom Integrations Requirements

Based on the official documentation and MCP auth specification:

### Core Requirements
1. **Dynamic Client Registration**: OAuth 2.0 Dynamic Client Registration Protocol
2. **OAuth 2.1 + PKCE**: Authorization Code flow with PKCE for all clients
3. **Authorization Server Metadata**: `.well-known/oauth-authorization-server` endpoint
4. **Bearer Token Authentication**: `Authorization: Bearer <token>` for requests
5. **MCP Protocol Headers**: `MCP-Protocol-Version` header support
6. **HTTPS**: All authorization endpoints must use HTTPS
7. **Token Management**: Token rotation, limited lifetimes, secure storage

### Optional Enhancements
- Resource subscriptions (not yet supported by Claude)
- Advanced draft capabilities (not yet supported by Claude)
- Binary/image tool results (already supported)

## Implementation Strategy

### Approach: Parallel Authentication Systems

Rather than replacing the existing OAuth 1.0a flow, we'll implement a parallel OAuth 2.1 system:

- **Keep existing flow**: Users can still authenticate via `/login` with Discogs OAuth 1.0a
- **Add new OAuth 2.1 flow**: Claude Custom Integrations will use this
- **Unified backend**: Both flows result in valid sessions for MCP protocol access
- **Backward compatibility**: No breaking changes to existing functionality

## Detailed Implementation Plan

### Phase 1: OAuth 2.1 Foundation (High Priority)

#### 1.1 Authorization Server Metadata Endpoint
- **File**: `src/auth/metadata.ts`
- **Endpoint**: `GET /.well-known/oauth-authorization-server`
- **Purpose**: Claude discovers OAuth endpoints and capabilities
- **Response**: JSON with authorization_endpoint, token_endpoint, registration_endpoint, etc.

#### 1.2 Dynamic Client Registration
- **File**: `src/auth/registration.ts`
- **Endpoint**: `POST /oauth/register`
- **Purpose**: Claude registers itself as an OAuth client
- **Storage**: Store client registrations in KV (`OAUTH_CLIENTS` namespace)
- **Response**: client_id, client_secret (for confidential clients)

#### 1.3 OAuth 2.1 Authorization Endpoint
- **File**: `src/auth/oauth2.ts`
- **Endpoint**: `GET /oauth/authorize`
- **Purpose**: OAuth authorization with PKCE support
- **Flow**: 
  1. Validate client_id, redirect_uri, PKCE challenge
  2. If user not authenticated → redirect to Discogs OAuth
  3. If authenticated → show consent screen
  4. Generate authorization code → redirect with code

#### 1.4 OAuth 2.1 Token Endpoint
- **File**: `src/auth/oauth2.ts`
- **Endpoint**: `POST /oauth/token`
- **Purpose**: Exchange authorization code for access token
- **Flow**:
  1. Validate authorization code + PKCE verifier
  2. Generate access_token + refresh_token
  3. Store tokens in KV with expiration
  4. Return OAuth 2.1 token response

### Phase 2: Integration & Protocol Updates (Medium Priority)

#### 2.1 Update SSE Transport
- **File**: `src/transport/sse.ts`
- **Changes**: 
  - Support both JWT cookie auth and OAuth 2.1 Bearer tokens
  - Add token validation function for Bearer tokens
  - Update connection authentication to handle both methods

#### 2.2 Update Main Request Handler
- **File**: `src/index.ts`
- **Changes**:
  - Add new OAuth endpoints to router
  - Update authentication middleware to handle Bearer tokens
  - Add MCP-Protocol-Version header validation
  - Ensure CORS headers support new endpoints

#### 2.3 Authentication Middleware Enhancement
- **File**: `src/auth/middleware.ts` (new)
- **Purpose**: Unified authentication that supports both methods
- **Functions**:
  - `verifyJWTAuth()` - existing JWT validation
  - `verifyBearerAuth()` - new OAuth 2.1 token validation
  - `verifyAuth()` - unified function that tries both methods

### Phase 3: Testing & Documentation (Low Priority)

#### 3.1 Comprehensive Testing
- **OAuth 2.1 flow tests**: Registration, authorization, token exchange
- **PKCE validation tests**: Valid/invalid challenges and verifiers
- **Bearer token authentication tests**: Valid/expired/invalid tokens
- **Backward compatibility tests**: Ensure existing flows still work
- **Integration tests**: Full Claude Custom Integrations simulation

#### 3.2 Documentation Updates
- **README.md**: Add Claude Custom Integrations setup instructions
- **CLAUDE.md**: Update with new OAuth 2.1 development commands
- **Environment setup**: Document new KV namespaces and secrets needed

## Technical Implementation Details

### New KV Namespaces Required
```toml
# wrangler.toml additions
[[env.production.kv_namespaces]]
binding = "OAUTH_CLIENTS"
id = "prod_oauth_clients_id"

[[env.production.kv_namespaces]]
binding = "OAUTH_TOKENS" 
id = "prod_oauth_tokens_id"
```

### New Environment Variables
- `OAUTH_SERVER_ISSUER` - OAuth server identifier URL
- `PKCE_CODE_CHALLENGE_METHODS_SUPPORTED` - Default: "S256"
- `TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED` - Default: "client_secret_basic,client_secret_post"

### Key Data Structures

#### Client Registration
```typescript
interface OAuthClient {
  client_id: string
  client_secret?: string
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  scope?: string
  token_endpoint_auth_method: string
  created_at: number
}
```

#### OAuth Token
```typescript
interface OAuthToken {
  access_token: string
  refresh_token?: string
  token_type: "Bearer"
  expires_in: number
  scope?: string
  user_id: string
  client_id: string
  created_at: number
}
```

## File Structure Changes

```
src/
├── auth/
│   ├── discogs.ts          # Existing Discogs OAuth 1.0a
│   ├── jwt.ts              # Existing JWT functions
│   ├── metadata.ts         # NEW: OAuth server metadata
│   ├── registration.ts     # NEW: Dynamic client registration
│   ├── oauth2.ts           # NEW: OAuth 2.1 endpoints
│   └── middleware.ts       # NEW: Unified auth middleware
├── transport/
│   └── sse.ts              # UPDATED: Support both auth methods
├── protocol/
│   └── handlers.ts         # UPDATED: Handle protocol version headers
└── index.ts                # UPDATED: Add OAuth 2.1 routes
```

## Testing Strategy

### Unit Tests
- OAuth 2.1 endpoint handlers
- PKCE code generation and validation
- Token generation and validation
- Client registration validation

### Integration Tests
- Full OAuth 2.1 authorization flow
- Bearer token authentication with MCP requests
- Backward compatibility with existing JWT auth
- Error handling for invalid/expired tokens

### Manual Testing
- Claude Custom Integrations setup simulation
- MCP Inspector tool compatibility
- Both authentication methods working simultaneously

## Deployment Considerations

### Rollout Strategy
1. **Deploy OAuth 2.1 endpoints** without breaking existing functionality
2. **Test with MCP Inspector tool** to validate protocol compliance
3. **Update production environment** with new KV namespaces
4. **Document setup process** for users wanting Claude integration
5. **Monitor both authentication flows** to ensure stability

### Monitoring
- Track OAuth 2.1 vs JWT authentication usage
- Monitor token expiration and refresh patterns
- Log client registration requests for debugging
- Rate limiting per OAuth client

## Success Criteria

### Functional Requirements
- [ ] Claude.ai can discover and register with the MCP server
- [ ] Users can add the server through Claude's Custom Integrations UI
- [ ] All existing MCP tools work with OAuth 2.1 authentication
- [ ] Existing JWT authentication continues to work unchanged
- [ ] Token refresh works properly for long-lived sessions

### Non-Functional Requirements
- [ ] No performance degradation on existing endpoints
- [ ] Secure token storage and validation
- [ ] Proper error handling for OAuth edge cases
- [ ] HTTPS enforcement for all OAuth endpoints
- [ ] Rate limiting prevents abuse of registration endpoint

## Implementation Checklist

### High Priority (Phase 1)
- [ ] 1.1 Create OAuth Authorization Server Metadata endpoint
- [ ] 1.2 Implement Dynamic Client Registration
- [ ] 1.3 Build OAuth 2.1 Authorization endpoint with PKCE
- [ ] 1.4 Create OAuth 2.1 Token endpoint
- [ ] 1.5 Set up new KV namespaces in Cloudflare

### Medium Priority (Phase 2)
- [ ] 2.1 Update SSE transport for Bearer token support
- [ ] 2.2 Add OAuth 2.1 routes to main request handler
- [ ] 2.3 Create unified authentication middleware
- [ ] 2.4 Add MCP-Protocol-Version header handling
- [ ] 2.5 Update CORS configuration for new endpoints

### Low Priority (Phase 3)
- [ ] 3.1 Write comprehensive OAuth 2.1 tests
- [ ] 3.2 Add PKCE validation tests
- [ ] 3.3 Test backward compatibility thoroughly
- [ ] 3.4 Update README with Claude setup instructions
- [ ] 3.5 Document new environment variables

### Validation & Deployment
- [ ] 4.1 Test with MCP Inspector tool
- [ ] 4.2 Simulate Claude Custom Integrations setup
- [ ] 4.3 Deploy to development environment
- [ ] 4.4 Run full test suite
- [ ] 4.5 Deploy to production
- [ ] 4.6 Monitor authentication flows post-deployment

## Notes for Multi-Session Development

- **Session 1**: Focus on OAuth server metadata and client registration
- **Session 2**: Implement authorization endpoint with PKCE
- **Session 3**: Build token endpoint and Bearer auth validation
- **Session 4**: Integrate with existing SSE transport and handlers
- **Session 5**: Testing, documentation, and deployment

Each session should include:
1. Update this document with progress
2. Run tests to ensure no regressions
3. Commit changes with clear messages
4. Update todos for next session