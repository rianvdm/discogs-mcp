# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# General instructions for completing tasks:

* Before starting implementation, provide an ELI5 explanation of what you're about to do
* Once implemented:
  	- Make sure the tests pass, and the program builds/runs
  	- Commit the changes to the repository with a clear commit message.
	- Explain what you did and what should now be possible. If I am able to manually test the latest change myself to make sure it works, give me instructions on how I can do that.
* Pause and wait for user review or feedback.

## Project Overview

This is a Cloudflare Workers-based MCP (Model Context Protocol) server that allows AI assistants to interact with users' personal Discogs music collections. The service implements OAuth authentication, intelligent search with mood mapping, and context-aware recommendations.

## Common Development Commands

### Build & Development
- `npm run dev` - Start local development server on port 8787
- `npm run build` - Dry-run build to check for errors
- `npm test` - Run Vitest tests with Cloudflare Workers environment
- `npm run lint` - Run ESLint with TypeScript checking
- `npm run format` - Format code with Prettier

### Deployment
- `npm run deploy` - Deploy to development environment
- `npm run deploy:prod` - Deploy to production environment

### Testing
- Run all tests: `npm test`
- Run specific test file: `npm test src/path/to/test.test.ts`
- Run tests in watch mode: `npm test -- --watch`

## Architecture Overview

### Core Structure
The codebase follows a clean architecture pattern with clear separation of concerns:

```
/src
├── auth/         # OAuth & JWT authentication logic
├── clients/      # Discogs API client with caching layer
├── protocol/     # MCP protocol implementation (handlers, parsing, validation)
├── transport/    # Server-Sent Events (SSE) transport layer
├── types/        # TypeScript type definitions
└── utils/        # Shared utilities (caching, logging, mood mapping, rate limiting)
```

### Key Architectural Decisions

1. **Edge Computing**: Built on Cloudflare Workers for global low-latency responses
2. **Stateless Design**: Uses KV storage for sessions/caching, no persistent database
3. **MCP over SSE**: Real-time communication using Server-Sent Events
4. **Smart Caching**: Implements intelligent caching to optimize Discogs API rate limits
5. **Mood Intelligence**: Advanced mapping system that converts emotional descriptors to music genres

### MCP Protocol Flow
1. Client sends JSON-RPC messages via POST to `/`
2. Server validates authentication via JWT tokens
3. Protocol handlers process tool calls (search_collection, get_release, etc.)
4. Responses stream back via SSE transport layer

### Key Files to Understand
- `src/index.ts` - Main entry point and request router
- `src/protocol/handler.ts` - Core MCP message handling logic
- `src/clients/DiscogsClient.ts` - API client with caching logic
- `src/utils/moodMapping.ts` - Intelligent mood-to-genre mapping
- `src/protocol/tools/searchCollection.ts` - Advanced search implementation

## Environment Configuration

### Secrets (set via `wrangler secret put`)
- `DISCOGS_CONSUMER_KEY` - OAuth consumer key
- `DISCOGS_CONSUMER_SECRET` - OAuth consumer secret
- `JWT_SECRET` - Secret for JWT signing

### KV Namespaces
- `AUTH_SESSIONS` - OAuth session storage
- `LOGS` - Structured logging storage
- `RATE_LIMIT` - Per-user rate limiting

### Environments
- Development: Default configuration in wrangler.toml
- Production: Use `--env production` flag with separate KV namespaces

## Code Style Guidelines

- **TypeScript**: Strict mode enabled, use explicit types
- **Formatting**: Prettier with 140 char width, single quotes, no semicolons, tabs
- **Imports**: Use absolute imports from 'src/' root
- **Error Handling**: Always use structured error responses with proper status codes
- **Logging**: Use the centralized logger utility for consistent structured logs

## Testing Approach

Tests use Vitest with Cloudflare Workers environment. Key patterns:
- Mock Discogs API responses for unit tests
- Test MCP protocol compliance for all tools
- Verify mood mapping logic with comprehensive test cases
- Check rate limiting and caching behavior

## Deployment Process

1. All changes to `main` branch auto-deploy to production via GitHub Actions
2. Manual deployments: `npm run deploy` (dev) or `npm run deploy:prod` (production)
3. CI pipeline runs lint, test, and build checks before deployment
4. Monitor deployment logs in Cloudflare dashboard

