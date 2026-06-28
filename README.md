# 🎵 Discogs MCP Server

[![Version](https://img.shields.io/badge/version-3.3.0-blue.svg)](https://github.com/rianvdm/discogs-mcp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-blue)](https://github.com/modelcontextprotocol)


[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rianvdm/discogs-mcp)

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

The fastest path is the **Deploy to Cloudflare** button above. It clones this repo into your GitHub account, provisions the KV namespaces and Durable Object in your Cloudflare account, prompts you for the three secrets, and sets up Workers Builds so future pushes to your fork redeploy automatically.

### 1. Register a Discogs developer app

Go to [discogs.com/settings/developers](https://www.discogs.com/settings/developers) → **Create an Application**. Name it anything; the Callback URL can be a placeholder for now (you'll come back and set it after the Worker is deployed). Save the **Consumer Key** and **Consumer Secret** — you'll paste them in next.

### 2. Click the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rianvdm/discogs-mcp)

When prompted, paste:

| Secret | Value |
|---|---|
| `DISCOGS_CONSUMER_KEY` | from step 1 |
| `DISCOGS_CONSUMER_SECRET` | from step 1 |
| `JWT_SECRET` | any random string — `openssl rand -hex 32` works |

After the deploy completes, Cloudflare shows your Worker URL — something like `https://discogs-mcp.<your-subdomain>.workers.dev`. The MCP endpoint is `/mcp`.

### 3. Update your Discogs app callback URL

Go back to [your Discogs app](https://www.discogs.com/settings/developers) and set the **Callback URL** to:

```
https://discogs-mcp.<your-subdomain>.workers.dev/discogs-callback
```

### 4. (Optional but recommended) Lock your instance to your own Discogs user

By default, anyone who discovers your Worker URL can authenticate and consume your Discogs rate-limit budget. To restrict it, edit `wrangler.toml` in your fork and set `ALLOWED_DISCOGS_USER_ID` under `[vars]`:

```toml
[vars]
# Single user
ALLOWED_DISCOGS_USER_ID = "123456"

# Or a comma-separated list for multiple users
ALLOWED_DISCOGS_USER_ID = "123456,789012,345678"
```

Find your numeric ID by visiting `https://api.discogs.com/users/<your-username>` and looking at the `id` field. Push the change — Workers Builds redeploys automatically.

### 5. Connect your MCP client

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

### Manual deploy (alternative)

If you'd rather skip the button — for example, you want a fully local clone or you're on a Cloudflare account where the button doesn't work:

```bash
git clone https://github.com/rianvdm/discogs-mcp.git
cd discogs-mcp
npm install

# Create the two KV namespaces and copy the returned IDs into wrangler.toml
# (replace the empty `id = ""` values under the top-level [[kv_namespaces]] blocks)
wrangler kv namespace create MCP_SESSIONS
wrangler kv namespace create OAUTH_KV

# Set the three secrets
wrangler secret put DISCOGS_CONSUMER_KEY
wrangler secret put DISCOGS_CONSUMER_SECRET
wrangler secret put JWT_SECRET

# Deploy
npm run deploy
```

Then follow steps 3–5 above (callback URL, optional allowlist, connect your MCP client).

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

**Search & discovery**

| Tool                   | Description                                                                  |
| ---------------------- | ---------------------------------------------------------------------------- |
| `search_collection`    | Search your collection with explicit genre filters, mood-aware ranking, and master-level dedup |
| `search_discogs`       | Search the Discogs-wide catalog (releases, masters, artists, labels) — marks results you already own |
| `get_release`          | Get detailed information about a specific release (tracklist, formats, labels) |
| `get_collection_stats` | View genre breakdown, decade analysis, format distribution, and ratings      |
| `get_recommendations`  | Get personalized recommendations by genre, decade, mood, or similarity       |

**Collection management**

| Tool                     | Description                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| `add_to_collection`      | Add a release to a folder (defaults to Uncategorized)                       |
| `remove_from_collection` | Remove a specific release instance from a folder                            |
| `move_release`           | Move a release instance between folders                                     |
| `rate_release`           | Rate a release from 0 (no rating) to 5 stars                                |

**Wantlist**

| Tool                   | Description                                                     |
| ---------------------- | -------------------------------------------------------------- |
| `get_wantlist`         | List releases on your wantlist (paginated)                     |
| `add_to_wantlist`      | Add a release to your wantlist                                 |
| `remove_from_wantlist` | Remove a release from your wantlist                            |

**Folders**

| Tool             | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `list_folders`   | List all folders with release counts                                |
| `create_folder`  | Create a new folder                                                 |
| `edit_folder`    | Rename an existing folder (system folders excluded)                 |
| `delete_folder`  | Delete an empty folder (system folders excluded)                    |

**Custom fields**

| Tool                 | Description                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| `list_custom_fields` | List all custom fields defined on your collection                                    |
| `edit_custom_field`  | Set a custom field value on a specific release instance                              |

**Diagnostics**

| Tool              | Description                                                         |
| ----------------- | ------------------------------------------------------------------- |
| `get_cache_stats` | View cache performance (total entries, pending requests, breakdown) |

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
