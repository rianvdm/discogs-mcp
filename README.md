# Discogs MCP

[![Latest release](https://img.shields.io/github/v/release/rianvdm/discogs-mcp)](https://github.com/rianvdm/discogs-mcp/releases)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rianvdm/discogs-mcp)

Discogs MCP is a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for your [Discogs](https://www.discogs.com/) music collection. Connect it to an AI assistant such as Claude and you can search what you own, look up a release, ask for something to play, and keep your collection, wantlist, and folders up to date by talking to it. It runs on Cloudflare Workers, signs in with your Discogs account through OAuth, and keeps a snapshot of your collection in Workers KV so that most questions get answered without a round trip to the Discogs API.

One thing to know before you go further: `discogs-mcp.com` is my own instance, and it's locked to my Discogs account. Anyone else gets a 403. You'll need to [deploy your own copy](#deploy-your-own-copy), which runs on Cloudflare's free Workers plan and takes about ten minutes. If you'd rather not do it by hand, there's a [prompt you can hand to a coding agent](#let-a-coding-agent-set-it-up). The reason for all this is the Discogs rate limit, and I explain it [below](#why-you-host-it-yourself).

## What you can do with it

Once a client is connected, you ask questions in plain language and the assistant calls the right tools. A few things that work well:

- "What do I own that would suit a rainy Sunday afternoon?"
- "Which Blue Note CDs do I have from the sixties?"
- "Find the original UK pressing of this on Discogs and add it to my wantlist."
- "Which of the records I marked 'watch' on my wantlist are for sale right now, and what's the cheapest copy?"
- "How is my collection split by decade and format?"
- "Move everything in my Unsorted folder that's rated five stars into Favourites."

Searching your collection takes natural-language queries. Mood words ("mellow", "energetic", "something for a dinner party") map onto genres and styles, "recent" and "oldest" are understood, and results are deduplicated at the master-release level so you don't get six pressings of the same album back. If the keyword pass finds nothing, the tool hands the collection to the assistant so it can pick for you.

Searching the whole Discogs catalog works the same way. It covers releases, masters, artists, and labels, and flags anything you already own.

Beyond search there are tools for collection statistics (genre, decade, format, and ratings), recommendations by genre, decade, mood, or similarity, and the day-to-day admin: adding and removing releases, moving them between folders, rating them, managing your wantlist, checking which wants are for sale and the lowest price, creating and renaming folders, and editing custom fields. The full list is under [Tools, resources, and prompts](#tools-resources-and-prompts).

Four times a day a scheduled job refreshes a snapshot of your collection in KV. Collection searches read from that snapshot instead of paging through the Discogs API, which keeps them fast and saves your rate-limit budget for the calls that need it.

## Why you host it yourself

The Discogs API allows 60 requests a minute, counted per source IP, and one person browsing a large collection can use all of that. A shared instance would spend most of its time rate-limited, so each person runs their own Worker with their own Discogs app credentials. Your copy talks to Discogs with your key, and nobody else's traffic counts against it.

Workers do share Cloudflare's outbound IP addresses with other Workers, so you can occasionally see a lower remaining budget than your own traffic explains. If that becomes a problem, see [routing Discogs calls through your own IP](#route-discogs-calls-through-your-own-ip).

## Deploy your own copy

The Deploy to Cloudflare button does most of the work. It clones this repo into your GitHub account, creates the KV namespaces and the Durable Object in your Cloudflare account, prompts you for two secrets, and sets up Workers Builds so that pushes to your fork redeploy automatically.

### 1. Register a Discogs app

Go to [discogs.com/settings/developers](https://www.discogs.com/settings/developers) and create an application. The name doesn't matter, and the callback URL can be a placeholder for now; you'll set the real one once the Worker exists. Keep the Consumer Key and Consumer Secret handy.

### 2. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rianvdm/discogs-mcp)

When prompted, provide:

| Secret                    | Value       |
| ------------------------- | ----------- |
| `DISCOGS_CONSUMER_KEY`    | from step 1 |
| `DISCOGS_CONSUMER_SECRET` | from step 1 |

When the deploy finishes, Cloudflare shows your Worker URL, something like `https://discogs-mcp.<your-subdomain>.workers.dev`. The MCP endpoint is `/mcp` on that host.

### 3. Set the callback URL

Back in [your Discogs app settings](https://www.discogs.com/settings/developers), set the Callback URL to:

```
https://discogs-mcp.<your-subdomain>.workers.dev/discogs-callback
```

### 4. Lock the instance to your Discogs user

This step is optional, and I recommend it. Without it, anyone who finds your Worker URL can sign in with their own Discogs account and spend your rate-limit budget. Edit `wrangler.toml` in your fork and set `ALLOWED_DISCOGS_USER_ID` under `[vars]`:

```toml
[vars]
# A single user
ALLOWED_DISCOGS_USER_ID = "123456"

# Or a comma-separated list
ALLOWED_DISCOGS_USER_ID = "123456,789012,345678"
```

Your numeric ID is the `id` field at `https://api.discogs.com/users/<your-username>`. Push the change and Workers Builds redeploys.

### Deploying by hand

If you'd rather not use the button (you want a plain local clone, or the button doesn't work on your Cloudflare account), the manual path is short:

```bash
git clone https://github.com/rianvdm/discogs-mcp.git
cd discogs-mcp
npm install

# Create the two KV namespaces and paste the returned IDs into wrangler.toml,
# replacing the empty `id = ""` values in the top-level [[kv_namespaces]] blocks
wrangler kv namespace create MCP_SESSIONS
wrangler kv namespace create OAUTH_KV

# Set the two secrets
wrangler secret put DISCOGS_CONSUMER_KEY
wrangler secret put DISCOGS_CONSUMER_SECRET

npm run deploy
```

Then follow steps 3 and 4 above.

## Let a coding agent set it up

If you use Claude Code, Codex, or a similar agent with shell access, you can hand it the whole job. It can't register the Discogs app or click through the OAuth screen for you (both happen in your browser), but it can do everything else: clone the repo, create the KV namespaces, store the secrets, deploy, look up your Discogs user ID, lock the instance to it, configure your client, and verify the result. Paste this and answer its questions as they come:

```
I want to self-host Discogs MCP from https://github.com/rianvdm/discogs-mcp
so I can use my Discogs collection from an MCP client. Read the README in that
repo, especially "Deploy your own copy", "Connect an MCP client", and "Running
it well", then do the setup for me.

Ground rules:
- Use the manual deploy path with wrangler, in a clone on this machine, so I
  end up with a local copy of the code.
- Ask before anything that costs money or changes my Cloudflare account beyond
  creating this Worker, its two KV namespaces, and its Durable Object.
- Don't paste secrets into chat or into files that are tracked by git. Use
  `wrangler secret put` for secrets and `.dev.vars` (gitignored) for local dev.

Steps I expect:
1. Check that Node 22, npm, and wrangler are installed and that wrangler is
   logged in to my Cloudflare account. Tell me how to fix anything missing.
2. Tell me to register a Discogs app at https://www.discogs.com/settings/developers
   with a placeholder callback URL, and wait for me to give you the Consumer
   Key and Consumer Secret.
3. Clone the repo, install dependencies, create the MCP_SESSIONS and OAUTH_KV
   namespaces, put their IDs into wrangler.toml, store the two secrets,
   and deploy. Tell me the Worker URL.
4. Tell me the exact callback URL to set on the Discogs app and wait for me to
   confirm I've done it.
5. Ask for my Discogs username, look up my numeric user ID at
   https://api.discogs.com/users/<username>, set ALLOWED_DISCOGS_USER_ID in
   wrangler.toml, and redeploy.
6. Ask which MCP client I use and configure it for the new endpoint.
7. Verify: call the server's ping and auth_status tools through the client
   (or MCP Inspector), walk me through the one-time OAuth sign-in, then run a
   search_collection query to confirm it returns my releases. Check
   get_cache_stats to see whether the first collection snapshot has landed.
8. Optional, only if I say yes when you ask: set up the Discogs egress relay
   described under "Route Discogs calls through your own IP". That needs an
   always-on machine or small VPS with its own IP, running either a Cloudflare
   Tunnel to a reverse proxy behind a Cloudflare Access service token, or a
   small proxy that checks the service-token headers itself. Explain the
   trade-offs before starting, and read src/rate-limiter/relay.ts for the
   details.

When you're done, summarise what you created, where the secrets live, and how
to update the deployment later.
```

The agent will stop at steps 2 and 4 because they need you in a browser. Everything else should run through without you.

## Connect an MCP client

Replace `https://your-worker.workers.dev` with your own URL in each of these.

Claude Desktop: Settings > Integrations > Add Integration, then enter `https://your-worker.workers.dev/mcp`.

Claude Code:

```bash
claude mcp add --transport http discogs https://your-worker.workers.dev/mcp
```

Windsurf (`~/.codeium/windsurf/mcp_config.json`):

```json
{
	"mcpServers": {
		"discogs": {
			"serverUrl": "https://your-worker.workers.dev/mcp"
		}
	}
}
```

Continue.dev, Zed, and other clients that only speak stdio can go through `mcp-remote`:

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

To poke at the server without a full client, MCP Inspector works well:

```bash
npx @modelcontextprotocol/inspector https://your-worker.workers.dev/mcp
```

The first time a client connects, it opens a browser window where you authorize the app on Discogs, and then sends you back. The server implements MCP's OAuth 2.1 flow with Discogs as the identity provider, so there's nothing to copy and paste. A session lasts seven days before you're asked to sign in again.

## Tools, resources, and prompts

Three tools work before you sign in:

| Tool          | Description                                                     |
| ------------- | --------------------------------------------------------------- |
| `ping`        | Test connectivity to the server                                 |
| `server_info` | Server version, capabilities, and how Discogs traffic is routed |
| `auth_status` | Check whether you're signed in, with login instructions if not  |

Everything else needs an authenticated session.

Search and discovery:

| Tool                   | Description                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `search_collection`    | Search your collection with natural language, genre filters, mood-aware ranking, and master-level dedup |
| `search_discogs`       | Search the full Discogs catalog (releases, masters, artists, labels), marking results you already own   |
| `get_release`          | Full details for one release: tracklist, formats, labels, notes                                         |
| `get_collection_stats` | Genre breakdown, decade analysis, format distribution, and ratings                                      |
| `get_recommendations`  | Picks from your own collection by genre, decade, mood, or similarity to a release                       |

Collection management:

| Tool                     | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `add_to_collection`      | Add a release to a folder (defaults to Uncategorized) |
| `remove_from_collection` | Remove a specific release instance from a folder      |
| `move_release`           | Move a release instance between folders               |
| `rate_release`           | Rate a release from 0 (no rating) to 5 stars          |

Wantlist:

| Tool                   | Description                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `get_wantlist`         | List your wantlist with each want's rating and notes; filter by notes text or minimum rating |
| `add_to_wantlist`      | Add a release to your wantlist                                                               |
| `remove_from_wantlist` | Remove a release from your wantlist                                                          |

Marketplace:

| Tool                    | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `get_marketplace_stats` | Copies for sale and the lowest asking price for up to 50 releases at a time |

Folders:

| Tool            | Description                                              |
| --------------- | -------------------------------------------------------- |
| `list_folders`  | List all folders with release counts                     |
| `create_folder` | Create a folder                                          |
| `edit_folder`   | Rename a folder (system folders can't be renamed)        |
| `delete_folder` | Delete an empty folder (system folders can't be deleted) |

Custom fields:

| Tool                 | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `list_custom_fields` | List the custom fields defined on your collection       |
| `edit_custom_field`  | Set a custom field value on a specific release instance |

Diagnostics:

| Tool                 | Description                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `get_cache_stats`    | Cache entry counts, the snapshot's size and fetch time, and the progress of any sync in flight |
| `refresh_collection` | Rebuild the collection snapshot now instead of waiting for the next scheduled sync             |

The server also exposes three MCP resources:

```
discogs://collection             # Complete collection (JSON)
discogs://release/{id}           # One release
discogs://search?q={query}       # Search results
```

And three prompts, for clients that support them:

| Prompt                | Description                                       | Arguments |
| --------------------- | ------------------------------------------------- | --------- |
| `browse_collection`   | Browse and explore your collection                |           |
| `find_music`          | Find specific music in your collection            | `query`   |
| `collection_insights` | Statistics and observations about your collection |           |

## Running it well

### Collection size and the free plan

On the free plan, the limit that matters is CPU time: 10 ms per invocation, for tool calls and the scheduled sync alike. The sync stores one page at a time to stay inside that budget, and the snapshot it builds keeps only the fields search needs (about 450 bytes per release). That comfortably covers collections up to roughly 2,000 releases. Past that, reading the snapshot on every search starts to crowd the budget, and a collection of 4,000 or more can see `search_collection` or `refresh_collection` fail with a bare execution error and no message. That's the runtime terminating the invocation, and it isn't a Discogs error. The fix is [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) ($5 a month), which raises the CPU budget to 30 seconds. Nothing else about the deployment changes.

Whatever plan you're on, `get_cache_stats` reports the snapshot's item count and fetch time, the page count of any sync in progress, and the outcome of the last sync run, so you can see whether the scheduled sync is landing.

### Watching wantlist records for sale

Discogs can email you when anything on your wantlist is listed, which gets noisy with a big wantlist. To hear about a handful of records instead, pair this server with an agent that runs on a schedule (a scheduled Claude task, for example):

1. On the Discogs website, add a word such as `watch` to the notes of each want you care about.
2. Have the agent run once a day: call `get_wantlist` with `notes_contains: "watch"`, pass the release IDs it returns to `get_marketplace_stats`, and tell you about anything that's for sale.

A prompt along these lines works: "Find the wants on my Discogs wantlist whose notes contain 'watch', check which are for sale, and message me with the price of any that are listed and weren't listed yesterday."

The server reports what's listed now. It doesn't remember earlier checks, so telling a new listing from one that was already there is the agent's job, and an agent that can't keep notes between runs will repeat the alert each day a copy stays up. The figures cover every listing for that exact release, whatever its condition or where the seller is, and may be up to an hour old. A filtered `get_wantlist` reads up to 5,000 wants, 100 per request, and each release `get_marketplace_stats` checks costs one request against Discogs' limit of 60 a minute, so keep the watch list to a few dozen records. On the free plan, a filtered read of a wantlist in the thousands may run into the same CPU limit described under [Collection size and the free plan](#collection-size-and-the-free-plan); if it fails with a bare execution error, Workers Paid fixes it.

### Route Discogs calls through your own IP

Discogs throttles by source IP, and a Worker's outbound requests leave from Cloudflare's shared egress IPs. Other Workers talking to Discogs from the same location eat into your 60 requests a minute, which is why a first request after hours of idle can already report a low `X-Discogs-Ratelimit-Remaining`. It can get worse than that. Discogs can refuse every request from the shared IP, the first one included, and keep refusing for days, so the scheduled sync fails on every run ([#89](https://github.com/rianvdm/discogs-mcp/issues/89)). If `get_cache_stats` shows the last sync failing with HTTP 429 run after run, set up a relay.

A relay is an always-on HTTPS endpoint you control that forwards the Worker's Discogs calls, so they leave from your IP. Whatever you run, it has to:

- forward the HTTP method, path, query, and request body (with its `Content-Type`) unchanged to `https://api.discogs.com`, because OAuth 1.0a signs the method and URL, and the write tools send request bodies
- make sure Discogs sees `Host: api.discogs.com`, and either no `X-Forwarded-Host` or one that's also `api.discogs.com`, so OAuth 1.0a signatures computed against the real URL still verify
- pass `Authorization` and `User-Agent` through
- return Discogs' status code, headers, and body unchanged, 429s included, because the Worker reads the `x-discogs-*` headers to pace itself
- answer its own failures (it can't reach Discogs, or the credentials are wrong) with a non-JSON error and no `x-discogs-*` headers, because that's how the Worker tells a broken relay from a Discogs error and retries the request directly; a JSON error from the relay is passed back as if Discogs had sent it
- refuse any request that doesn't carry the right `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, so it isn't an open proxy

Two setups are known to work. One is a Cloudflare Tunnel to an always-on machine (a home Mac, a small VPS) with a local reverse proxy that forwards to `https://api.discogs.com` and sets both `Host` and `X-Forwarded-Host` to `api.discogs.com`. cloudflared alone can't do this, because it overwrites `X-Forwarded-Host`. Put a Cloudflare Access application with a service-token policy in front of the tunnel hostname, and Access checks the two headers for you.

The other is a small proxy on a VPS or an always-on container host that checks the two headers itself (with a constant-time comparison) and strips its platform's forwarding headers before calling Discogs. One self-hoster runs a dependency-free Node proxy like this on Fly.io ([#89](https://github.com/rianvdm/discogs-mcp/issues/89)).

Either way, point the Worker at it:

```bash
# wrangler.toml, under [vars]: DISCOGS_RELAY_ORIGIN = "https://relay.example.com"
wrangler secret put RELAY_ACCESS_CLIENT_ID
wrangler secret put RELAY_ACCESS_CLIENT_SECRET
```

Keep `DISCOGS_RELAY_ORIGIN` in `wrangler.toml` and set both credentials as secrets, the client ID included. Wrangler treats the config file as the source of truth, so a plain variable added in the Cloudflare dashboard is removed by the next `wrangler deploy` unless you set `keep_vars = true`. Secrets survive deploys ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)). If the origin is set and a secret is missing, the relay stays off, and `ping` and `server_info` name the variable to set.

Leave `DISCOGS_RELAY_ORIGIN` empty to call Discogs directly, which is the default. When the relay answers with an error of its own (a Tunnel with no connector, the proxy behind it down, Access rejecting the token), the Worker retries that request directly and logs a fallback, so a switched-off machine behind a Tunnel degrades to the shared-IP behaviour. A relay host the Worker can't connect to at all, with no HTTP response, isn't retried: those requests fail with a 502 until the host is back. The implementation and the reasoning behind it are in `src/rate-limiter/relay.ts`.

### Diagnostics

`ping` and `server_info` report how Discogs traffic is leaving (direct, or via the relay), whether the relay has fallen back to direct calls, and which relay credential is missing if the relay is half set up. `get_cache_stats` shows how the last collection sync went: its outcome, what triggered it and when, and, if it failed, the error, how many runs in a row have failed, and when the last healthy run was. For the rate limiter's live state (remaining budget, queue depth, circuit-breaker status, relay fallbacks), set a `DEBUG_TOKEN` secret and call `GET /debug/budget?token=<DEBUG_TOKEN>`. Without the secret, the endpoint returns 404, so a self-hosted instance never exposes it by accident.

## Developing

Dev secrets live in `.dev.vars`, which is gitignored. The same Discogs app you registered for production is fine for local use.

```bash
cp .dev.vars.example .dev.vars   # then fill in DISCOGS_CONSUMER_KEY and DISCOGS_CONSUMER_SECRET
npm run dev                      # Worker on http://localhost:8787
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

The default `[vars]` block in `wrangler.toml` leaves `ALLOWED_DISCOGS_USER_ID` empty, so a local instance accepts any Discogs account.

Tests run inside workerd through `@cloudflare/vitest-pool-workers` and need Node 22 (see `.nvmrc`):

```bash
npm test              # vitest in watch mode
npx vitest run        # one pass, then exit
npm run lint          # ESLint; CI runs lint, the tests, and a dry-run build
```

CI deploys to production when `main` changes. The architecture, code conventions, and testing notes are in [AGENTS.md](AGENTS.md), and pull requests are welcome.

## License

[MIT](LICENSE).
