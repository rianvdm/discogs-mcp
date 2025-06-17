# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# General instructions for completing tasks:

* Before starting implementation, provide an ELI5 explanation of what you're about to do
* Once implemented:
 	- Make sure the tests pass, and the program builds/runs
 	- Commit the changes to the repository with a clear commit message.
   - Explain what you did and what should now be possible. If I am able to manually test the latest change myself to make sure it works, give me instructions on how I can do that.
* Pause and wait for user review or feedback.

# Writing code

- We prefer simple, clean, maintainable solutions over clever or complex ones, even if the latter are more concise or performant. Readability and maintainability are primary concerns.
- Write code that works today but can grow tomorrow. Avoid premature optimization, but don't paint yourself into architectural corners.
- Make the smallest reasonable changes to get to the desired outcome. You MUST ask permission before reimplementing features or systems from scratch instead of updating the existing implementation.
- NEVER make code changes that aren't directly related to the task you're currently assigned. If you notice something that should be fixed but is unrelated to your current task, document it as a new item in `todo.md` with priority level (P0/P1/P2).
- Only remove comments that are demonstrably incorrect or misleading.
- All code files should start with a brief 2 line comment explaining what the file does. Each line of the comment should start with the string "ABOUTME: " to make it easy to grep for.
- When writing comments, avoid referring to temporal context about refactors or recent changes. Comments should be evergreen and describe the code as it is, not how it evolved or was recently changed.
- Handle errors gracefully with clear, actionable messages. Fail fast for programming errors, recover gracefully for user/external errors.
- Minimize external dependencies. When adding new dependencies, justify the choice and document the decision.
- Avoid mocks for core business logic, but they're acceptable for external APIs during development.
- When you are trying to fix a bug or compilation error or any other issue, YOU MUST NEVER throw away the old implementation and rewrite without explicit permission from the user. If you are going to do this, YOU MUST STOP and get explicit permission from the user.
- NEVER name things as 'improved' or 'new' or 'enhanced', etc. Code naming should be evergreen. What is new today will be "old" someday.
- Update README.md when adding new features or changing how the project works. Keep setup/usage instructions current.

# Getting help

- ALWAYS ask for clarification rather than making assumptions.
- If you're having trouble with something, it's ok to stop and ask for help. Especially if it's something your human might be better at.

# Testing

- All projects need comprehensive tests. Start with the most critical test type for the project's scope and add others as complexity grows.
- Tests MUST cover the functionality being implemented.
- NEVER ignore the output of the system or the tests - Logs and messages often contain CRITICAL information.
- TEST OUTPUT MUST BE PRISTINE TO PASS.
- If the logs are supposed to contain errors, capture and test it.

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

