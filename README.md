# 🎵 Discogs MCP Server

[![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)](https://github.com/rianvdm/discogs-mcp/releases/tag/v3.0.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-blue)](https://github.com/modelcontextprotocol)

A powerful **Model Context Protocol (MCP) server** that enables AI assistants to interact with your personal Discogs music collection. Built on Cloudflare Workers using the official **Cloudflare Agents SDK** and **@modelcontextprotocol/sdk**.

## ✨ Features

- 🔐 **Secure OAuth Authentication**: Connect your Discogs account safely
- 🧠 **Intelligent Mood Mapping**: Translate emotions into music ("mellow", "energetic", "Sunday evening vibes")
- 🔍 **Advanced Search Intelligence**: Multi-strategy search with OR logic and relevance scoring
- 📊 **Collection Analytics**: Comprehensive statistics and insights about your music
- 🎯 **Context-Aware Recommendations**: Smart suggestions based on mood, genre, and similarity
- ⚡ **Edge Computing**: Global low-latency responses via Cloudflare Workers
- 🗂️ **Smart Caching**: Intelligent KV-based caching for optimal performance

## ⚠️ This Is Not a Shared Service

**`discogs-mcp.com` is the maintainer's private instance.** It's locked to a single Discogs account and will return a 403 for anyone else.

Why? The Discogs API rate limit (60 requests per minute, per registered app) is too tight to share across users. One active collection query from a single user can saturate it. Rather than run a broken multi-tenant service, **each user deploys their own Worker with their own Discogs API credentials**.

The good news: deploying your own copy is straightforward, runs on the Cloudflare Workers free tier, and takes about 10 minutes. See [Self-Hosting](#-self-hosting) below.

## 🚀 Self-Hosting

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier is fine)
- Discogs account with a [registered developer app](https://www.discogs.com/settings/developers) (you'll need a **Consumer Key** and **Consumer Secret**)

### 1. Clone and install

```bash
git clone https://github.com/rianvdm/discogs-mcp.git
cd discogs-mcp
npm install
```

### 2. Create KV namespaces

```bash
wrangler kv namespace create MCP_SESSIONS --env production
wrangler kv namespace create MCP_LOGS --env production
wrangler kv namespace create OAUTH_KV --env production
```

Copy the returned IDs into `wrangler.toml` under `[env.production]`.

### 3. Set your Discogs credentials

```bash
wrangler secret put DISCOGS_CONSUMER_KEY --env production
wrangler secret put DISCOGS_CONSUMER_SECRET --env production
wrangler secret put JWT_SECRET --env production   # any random string
```

### 4. (Optional but recommended) Lock your instance to your own Discogs user

By default, anyone with a Discogs account who discovers your Worker URL can authenticate and consume your rate-limit budget. To restrict it to just you — or to a small group of trusted users — set `ALLOWED_DISCOGS_USER_ID` in `wrangler.toml` under `[env.production.vars]`:

```toml
[env.production.vars]
# Single user
ALLOWED_DISCOGS_USER_ID = "123456"

# Or a comma-separated list for multiple users
ALLOWED_DISCOGS_USER_ID = "123456,789012,345678"
```

You can find your numeric ID by visiting `https://api.discogs.com/users/<your-username>` and looking at the `id` field. Leave the value empty to run an open instance.

### 5. Deploy

```bash
npm run deploy:prod
```

Your Worker URL will be something like `https://discogs-mcp.<your-subdomain>.workers.dev`. The MCP endpoint is `/mcp`.

### 6. Connect your MCP client

Replace `https://your-worker.workers.dev` below with your own URL.

**Claude Desktop** — Settings → Integrations → Add Integration → `https://your-worker.workers.dev/mcp`

**Claude Code**:

```bash
claude mcp add --transport http discogs https://your-worker.workers.dev/mcp
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "discogs": {
      "serverUrl": "https://your-worker.workers.dev/mcp"
    }
  }
}
```

**Continue.dev / Zed / Generic:**

```json
{
  "mcpServers": {
    "discogs": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-worker.workers.dev/mcp"]
    }
  }
}
```

**MCP Inspector (testing)**:

```bash
npx @modelcontextprotocol/inspector https://your-worker.workers.dev/mcp
```

## 🔐 Authentication

This server uses **MCP OAuth 2.1** with Discogs as the identity provider. When you connect for the first time:

1. Your MCP client automatically opens a browser window
2. Authorize the application on Discogs
3. You're redirected back and authenticated — no copy-pasting required
4. Your session persists for 7 days

## 🛠️ Available Tools

### 🔓 Public Tools (No Authentication Required)

| Tool          | Description                                            |
| ------------- | ------------------------------------------------------ |
| `ping`        | Test server connectivity                               |
| `server_info` | Get server information and capabilities                |
| `auth_status` | Check authentication status and get login instructions |

### 🔐 Authenticated Tools (Requires Login)

| Tool                   | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `search_collection`    | Search your collection with intelligent mood and genre matching |
| `get_release`          | Get detailed information about a specific release               |
| `get_collection_stats` | View comprehensive collection statistics                        |
| `get_recommendations`  | Get context-aware music recommendations                         |
| `get_cache_stats`      | Monitor cache performance (development)                         |

## 📚 MCP Resources

Access Discogs data via standardized MCP resource URIs:

```
discogs://collection             # Complete collection (JSON)
discogs://release/{id}           # Specific release details
discogs://search?q={query}       # Search results
```

## 🏗️ Local Development

```bash
# Set dev secrets (same Discogs app is fine for dev)
wrangler secret put DISCOGS_CONSUMER_KEY
wrangler secret put DISCOGS_CONSUMER_SECRET
wrangler secret put JWT_SECRET

# Run the Worker locally
npm run dev

# Test with MCP Inspector
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

The default `[vars]` block in `wrangler.toml` leaves `ALLOWED_DISCOGS_USER_ID` empty, so local dev is open to any Discogs account — convenient for testing.

## 🧪 Testing

```bash
npm test              # Run all tests
npm test -- --watch  # Run tests in watch mode
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Discogs](https://www.discogs.com/) for the music database API
- [Model Context Protocol](https://modelcontextprotocol.io/) for the standard
- [Cloudflare Workers](https://workers.cloudflare.com/) for the platform
