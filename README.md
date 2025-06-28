# 🎵 Discogs MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

A powerful MCP (Model Context Protocol) server that enables AI assistants to interact with your personal Discogs music collection. Built on Cloudflare Workers with intelligent mood mapping, advanced search capabilities, and seamless OAuth authentication.

## ✨ Features

- 🔐 **Secure OAuth Authentication** - Connect your Discogs account safely
- 🧠 **Intelligent Mood Mapping** - Translate emotions into music ("mellow", "energetic", "Sunday evening vibes")
- 🔍 **Advanced Search Intelligence** - Multi-strategy search with OR logic and relevance scoring
- 📊 **Collection Analytics** - Comprehensive statistics and insights about your music
- 🎯 **Context-Aware Recommendations** - Smart suggestions based on mood, genre, and similarity
- ⚡ **Edge Computing** - Global low-latency responses via Cloudflare Workers
- 🗂️ **Smart Caching** - Intelligent KV-based caching for optimal performance
- 🚦 **Rate Limiting** - Per-user throttling to respect API limits

## 🚀 Quick Start

### Adding to Claude Desktop

1. **Open Claude Desktop settings**: Go to Settings → Developer → Edit Config
2. **Open the file in any text editor, and add the server configuration**:

```json
{
  "mcpServers": {
    "discogs": {
      "command": "npx",
      "args": ["mcp-remote", "https://discogs-mcp-prod.rian-db8.workers.dev/sse"]
    }
  }
}
```

3. **Restart Claude Desktop**
4. **Test the connection**: Ask "What can you tell me about my Discogs collection?"
5. **Authenticate**: Visit the provided login URL to connect your Discogs account
6. **Start exploring**: Try the example queries below!

### Adding to Other MCP Clients

For other MCP-compatible clients, use the server endpoint:

```
https://discogs-mcp-prod.rian-db8.workers.dev/sse
```

## 🎯 What You Can Ask Your AI Assistant

### Multi-Genre Searches
- *"Show me psychedelic rock prog rock space rock albums"* - Uses OR logic for broader results
- *"Find jazz fusion bebop hard bop albums from the 70s"* - Combines multiple subgenres
- *"What electronic techno house trance music do I own?"* - Flexible genre matching

### Mood-Based Queries
- *"I want something mellow for Sunday evening"* - Contextual mood mapping
- *"Find energetic music for working out"* - Activity-based recommendations
- *"What's good for a cozy winter evening?"* - Seasonal and mood awareness
- *"Show me dark and brooding music for a rainy day"* - Emotional context understanding

### Contextual Recommendations
- *"Suggest albums similar to Pink Floyd's Dark Side of the Moon"* - Similarity matching
- *"What are my highest-rated jazz albums from the 1960s?"* - Era and rating filtering
- *"Find romantic music for a dinner date"* - Social context awareness
- *"Give me chill music for studying"* - Activity-specific suggestions

### Collection Analysis
- *"What does my collection say about my musical taste?"* - Comprehensive analysis
- *"Show me my collection statistics"* - Detailed breakdowns by genre, decade, format
- *"How many albums do I have from each decade?"* - Temporal analysis

### Recent Activity & Discovery
- *"Show me my recent collection additions"* - Timeline of latest acquisitions
- *"What have I added to my collection lately?"* - Recent activity overview

## 🔗 Authentication

Authentication uses Discogs OAuth 1.0a flow:

1. **Initiate**: Use the `auth_status` tool to get your personalized login URL
2. **Authorize**: Visit the URL and authorize the application on Discogs
3. **Connect**: You'll be automatically redirected back with a success message
4. **Enjoy**: Your session persists for 7 days with automatic cross-origin support

The server handles all OAuth complexity behind the scenes - just visit the URL and you're connected!

## 🛠️ Available Tools

| Tool | Description | Authentication |
|------|-------------|----------------|
| `ping` | Test server connectivity | ❌ |
| `server_info` | Get server information and capabilities | ❌ |
| `auth_status` | Check authentication status and get login instructions | ❌ |
| `search_collection` | Search your collection with intelligent mood and genre matching | ✅ |
| `get_release` | Get detailed information about a specific release | ✅ |
| `get_collection_stats` | View comprehensive collection statistics | ✅ |
| `get_recommendations` | Get context-aware music recommendations | ✅ |
| `get_recent_activity` | View recent collection additions and activity timeline | ✅ |
| `get_cache_stats` | Monitor cache performance (development) | ✅ |

## 💡 API Examples

### Test Connection
```bash
curl -X POST https://discogs-mcp-prod.rian-db8.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "ping",
      "arguments": {
        "message": "Hello Discogs!"
      }
    }
  }'
```

### Check Authentication Status
```bash
curl -X POST https://discogs-mcp-prod.rian-db8.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "auth_status"
    }
  }'
```

### Search Collection (Authenticated)
```bash
curl -X POST https://discogs-mcp-prod.rian-db8.workers.dev \
  -H "Content-Type: application/json" \
  -H "Cookie: session=YOUR_SESSION_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_collection",
      "arguments": {
        "query": "mellow jazz for studying"
      }
    }
  }'
```

## 🏗️ How It Works

Built on **Cloudflare Workers** for global edge computing with:
- **OAuth 1.0a Authentication** - Secure Discogs account connection
- **Intelligent Caching** - Smart KV-based caching for optimal performance
- **MCP Protocol** - Standard interface for AI assistant integration
- **Mood Intelligence** - Advanced emotional context understanding

The server runs at the edge globally, providing low-latency responses while respecting Discogs API rate limits through intelligent caching and request optimization.

---

## 🔧 Development

### Prerequisites
- Node.js 18+
- npm or yarn
- Cloudflare account
- Discogs Developer Account

### Local Setup
```bash
# Clone the repository
git clone https://github.com/rianvdm/discogs-mcp.git
cd discogs-mcp

# Install dependencies
npm install

# Start development server
npm run dev
```

### Claude Desktop Configuration

For local development, copy the configuration from `.devtools/config/claude-desktop-config.json`:

```json
{
  "mcpServers": {
    "discogs-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8787/sse"]
    }
  }
}
```

For production, use `.devtools/config/claude-desktop-config-production.json` as a template.

### Environment Configuration
```bash
# Set your Discogs API credentials as Wrangler secrets
wrangler secret put DISCOGS_CONSUMER_KEY
wrangler secret put DISCOGS_CONSUMER_SECRET
wrangler secret put JWT_SECRET
```

### Available Scripts
```bash
npm run dev        # Start local development server
npm test           # Run test suite
npm run lint       # Run ESLint
npm run format     # Format code with Prettier
npm run build      # Build for production
npm run deploy     # Deploy to development
npm run deploy:prod # Deploy to production
```

## 🚀 Deployment

### Production Setup
1. **Create KV namespaces**:
   ```bash
   npm run setup:prod
   ```

2. **Set Cloudflare secrets**:
   ```bash
   wrangler secret put DISCOGS_CONSUMER_KEY
   wrangler secret put DISCOGS_CONSUMER_SECRET
   wrangler secret put JWT_SECRET
   ```

3. **Deploy**:
   ```bash
   npm run deploy:prod
   ```

### GitHub Actions
The project includes automated CI/CD:
- **CI Pipeline**: Runs on all pushes and PRs (lint, test, build)
- **Production Deployment**: Auto-deploys `main` branch to production

### Required Secrets
**Cloudflare** (via `wrangler secret put`):
- `DISCOGS_CONSUMER_KEY`
- `DISCOGS_CONSUMER_SECRET`
- `JWT_SECRET`

**GitHub** (for automation):
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## 🧪 Testing

The project includes comprehensive tests:
- **Unit Tests** - Individual component testing
- **Integration Tests** - Full MCP protocol flow
- **API Tests** - Discogs API integration
- **Authentication Tests** - OAuth flow validation

```bash
npm test              # Run all tests
npm test -- --watch  # Run tests in watch mode
npm test auth         # Run specific test suite
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Discogs](https://www.discogs.com/) for providing the comprehensive music database API
- [Model Context Protocol](https://modelcontextprotocol.io/) for the standard protocol
- [Cloudflare Workers](https://workers.cloudflare.com/) for the serverless platform
- The open-source community for inspiration and tools