// ABOUTME: Static HTML marketing page for the Discogs MCP Server home page.
// ABOUTME: Served at GET / to showcase the project and aid SEO for "Discogs MCP".

export const MARKETING_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Discogs MCP Server — Self-Hosted MCP for Your Record Collection</title>
    <meta name="description" content="Discogs MCP is a free, open-source MCP server you self-host on Cloudflare Workers to connect Claude and other AI assistants to your own Discogs collection.">
    <meta name="keywords" content="Discogs MCP, Discogs MCP server, Model Context Protocol, Claude, AI, vinyl, record collection, self-hosted">
    <link rel="canonical" href="https://discogs-mcp.com">

    <meta property="og:title" content="Discogs MCP Server (self-hosted)">
    <meta property="og:description" content="Self-hosted MCP server that connects Claude to your Discogs record collection. Clone, deploy on Cloudflare Workers, use your own Discogs API key.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://discogs-mcp.com">

    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="Discogs MCP Server (self-hosted)">
    <meta name="twitter:description" content="Self-hosted MCP server for your Discogs record collection.">

    <meta name="robots" content="index, follow">

    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%23FFBF00'/%3E%3Ccircle cx='12' cy='12' r='4' fill='%23111'/%3E%3Ccircle cx='12' cy='12' r='1.5' fill='%23FFBF00'/%3E%3C/svg%3E">

    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "name": "Discogs MCP Server",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Cross-platform",
      "description": "Open-source, self-hosted Model Context Protocol server connecting AI assistants to your Discogs music collection. Deploy your own instance on Cloudflare Workers.",
      "url": "https://discogs-mcp.com",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
      "license": "https://opensource.org/licenses/MIT"
    }
    </script>

    <style>
        :root {
            --yellow: #FFBF00;
            --yellow-dark: #E5A800;
            --yellow-bg: #FFFBEA;
            --yellow-border: #F5E070;
            --text: #111;
            --text-muted: #555;
            --text-dim: #999;
            --border: #F0F0F0;
            --border-card: #E8E8E8;
            --bg-section: #FAFAFA;
            --bg-code: #F5F5F5;
            --border-code: #E0E0E0;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #fff;
            color: var(--text);
            line-height: 1.5;
            min-height: 100vh;
        }

        .container { max-width: 900px; margin: 0 auto; padding: 0 32px; }

        /* ── HEADER ── */
        header {
            border-bottom: 2px solid var(--yellow);
            padding: 14px 0;
        }

        .header-inner {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .logo {
            font-weight: 800;
            font-size: 1rem;
            color: var(--text);
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .logo-badge {
            background: var(--yellow);
            color: var(--text);
            font-size: 0.6rem;
            font-weight: 800;
            padding: 2px 7px;
            border-radius: 3px;
            letter-spacing: 0.06em;
        }

        nav { display: flex; gap: 24px; }

        nav a {
            color: var(--text-muted);
            text-decoration: none;
            font-size: 0.9rem;
            transition: color 0.2s;
        }

        nav a:hover { color: var(--text); }

        /* ── HERO ── */
        .hero {
            display: flex;
            min-height: 280px;
            max-width: 900px;
            margin: 0 auto;
            width: 100%;
        }

        .hero-left {
            flex: 1;
            padding: 52px 40px 48px;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }

        .hero-left h1 {
            font-size: 2.4rem;
            font-weight: 800;
            color: var(--text);
            line-height: 1.15;
            margin-bottom: 16px;
            letter-spacing: -0.02em;
        }

        .hero-left h1 .hl {
            background: var(--yellow);
            padding: 0 6px;
        }

        .hero-left p {
            font-size: 1rem;
            color: var(--text-muted);
            line-height: 1.6;
            max-width: 400px;
            margin-bottom: 28px;
        }

        .hero-left p strong { color: var(--text); font-weight: 600; }

        .cta-row { display: flex; gap: 12px; flex-wrap: wrap; }

        .btn {
            padding: 11px 22px;
            border-radius: 6px;
            font-size: 0.9rem;
            font-weight: 700;
            text-decoration: none;
            transition: all 0.2s;
            display: inline-block;
        }

        .btn-primary {
            background: var(--yellow);
            color: var(--text);
        }

        .btn-primary:hover { background: var(--yellow-dark); }

        .btn-secondary {
            background: transparent;
            color: #333;
            border: 1px solid #CCC;
        }

        .btn-secondary:hover { border-color: #999; color: var(--text); }

        .hero-right {
            width: 220px;
            background: #111;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 14px;
            flex-shrink: 0;
            padding: 32px;
        }

        .record {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            background: repeating-conic-gradient(#2a2a2a 0deg 5deg, #1a1a1a 5deg 10deg, #333 10deg 15deg, #222 15deg 20deg);
            position: relative;
            animation: spin 6s linear infinite;
        }

        .record::before {
            content: '';
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            width: 44px; height: 44px;
            border-radius: 50%;
            background: radial-gradient(circle, #FFBF00 0%, #E5A800 40%, #222 42%);
        }

        .record::after {
            content: '';
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            width: 8px; height: 8px;
            border-radius: 50%;
            background: #111;
        }

        @keyframes spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
        }

        .now-spinning {
            font-size: 0.65rem;
            color: #888;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }

        /* ── QUERIES ── */
        .queries {
            padding: 48px 0;
            border-top: 1px solid var(--border);
        }

        .queries h2 {
            font-size: 1.3rem;
            font-weight: 700;
            margin-bottom: 24px;
            letter-spacing: -0.01em;
        }

        .query-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 14px;
        }

        .query-card {
            background: var(--bg-section);
            border: 1px solid #EEE;
            border-left: 3px solid var(--yellow);
            border-radius: 6px;
            padding: 16px 18px;
        }

        .query-card.featured {
            background: var(--yellow-bg);
            border-color: var(--yellow-border);
        }

        .query-card q {
            font-style: normal;
            color: var(--text);
            font-size: 0.9rem;
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
        }

        .query-card q::before { content: '\u201C'; color: var(--yellow); font-weight: 800; }
        .query-card q::after  { content: '\u201D'; color: var(--yellow); font-weight: 800; }

        .query-card span { color: #777; font-size: 0.8rem; }

        /* ── NOTICE BANNER ── */
        .notice {
            background: #FFF8E1;
            border-top: 1px solid var(--yellow-border);
            border-bottom: 1px solid var(--yellow-border);
            padding: 14px 0;
        }
        .notice p {
            color: #5a4a00;
            font-size: 0.85rem;
            line-height: 1.5;
            text-align: center;
        }
        .notice p strong { color: #3a2f00; }
        .notice a { color: var(--yellow-dark); font-weight: 600; }

        .mood-tag {
            display: inline-block;
            background: var(--yellow);
            color: var(--text);
            font-size: 0.6rem;
            font-weight: 700;
            padding: 1px 7px;
            border-radius: 3px;
            margin-left: 6px;
            vertical-align: middle;
            letter-spacing: 0.04em;
        }

        /* ── SETUP ── */
        .setup {
            padding: 48px 0;
            border-top: 1px solid var(--border);
            background: var(--bg-section);
        }

        .setup h2 {
            font-size: 1.3rem;
            font-weight: 700;
            margin-bottom: 24px;
            letter-spacing: -0.01em;
        }

        .setup-list { display: flex; flex-direction: column; gap: 16px; }

        .setup-card {
            background: #fff;
            border: 1px solid var(--border-card);
            border-radius: 8px;
            padding: 20px 24px;
        }

        .setup-card h3 {
            font-size: 0.95rem;
            font-weight: 700;
            margin-bottom: 6px;
        }

        .setup-card p {
            color: var(--text-muted);
            font-size: 0.85rem;
            margin-bottom: 12px;
        }

        .setup-card ol {
            color: var(--text-muted);
            font-size: 0.85rem;
            padding-left: 20px;
            margin-bottom: 12px;
        }

        .setup-card ol li { margin-bottom: 4px; }
        .setup-card ol li strong { color: var(--text); font-weight: 500; }

        .config-path {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.78rem;
            color: var(--text-dim);
            margin-bottom: 12px;
        }

        .code-wrap { position: relative; }

        .setup-card code {
            display: block;
            background: var(--bg-code);
            border: 1px solid var(--border-code);
            border-radius: 4px;
            padding: 10px 40px 10px 14px;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.8rem;
            color: var(--text);
            overflow-x: auto;
            white-space: pre;
            min-height: 40px;
        }

        .copy-btn {
            position: absolute;
            top: 7px; right: 8px;
            background: #fff;
            border: 1px solid #DDD;
            border-radius: 4px;
            padding: 2px 8px;
            font-size: 0.65rem;
            color: #888;
            cursor: pointer;
            transition: all 0.2s;
            font-family: -apple-system, sans-serif;
        }

        .copy-btn:hover { border-color: #AAA; color: var(--text); }
        .copy-btn.copied { color: var(--yellow-dark); border-color: var(--yellow); }

        /* ── TOOLS ── */
        .tools {
            padding: 48px 0;
            border-top: 1px solid var(--border);
        }

        .tools h2 {
            font-size: 1.3rem;
            font-weight: 700;
            margin-bottom: 24px;
            letter-spacing: -0.01em;
        }

        .tool-cols {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 40px;
        }

        .tool-col h3 {
            font-size: 0.7rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--text-dim);
            margin-bottom: 14px;
        }

        .tool-col ul { list-style: none; }

        .tool-col li {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.85rem;
            color: #444;
            padding: 7px 0;
            border-bottom: 1px solid var(--border);
        }

        .tool-col li:last-child { border-bottom: none; }

        /* ── FOOTER ── */
        footer {
            border-top: 1px solid var(--border);
            padding: 32px 0;
            text-align: center;
        }

        .footer-links {
            display: flex;
            justify-content: center;
            gap: 28px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }

        .footer-links a {
            color: var(--text-muted);
            text-decoration: none;
            font-size: 0.85rem;
            transition: color 0.2s;
        }

        .footer-links a:hover { color: var(--text); }

        .footer-note {
            color: #AAA;
            font-size: 0.8rem;
        }

        .footer-note a { color: var(--yellow-dark); text-decoration: none; }

        /* ── RESPONSIVE ── */
        @media (max-width: 640px) {
            .hero { display: block; }
            .hero-left { padding: 40px 24px 32px; }
            .hero-left h1 { font-size: 1.8rem; }
            .hero-right { width: 100%; height: auto; padding: 28px 32px; }
            .query-grid { grid-template-columns: 1fr; }
            nav { gap: 16px; }
            .cta-row { flex-direction: column; align-items: center; }
            .btn { width: 100%; max-width: 280px; text-align: center; }
            .tool-cols { grid-template-columns: 1fr; gap: 24px; }
        }
    </style>
</head>
<body>
    <header>
        <div class="container">
            <div class="header-inner">
                <a href="/" class="logo">
                    Discogs MCP
                    <span class="logo-badge">MCP</span>
                </a>
                <nav>
                    <a href="#setup">Setup</a>
                    <a href="#tools">Tools</a>
                    <a href="https://github.com/rianvdm/discogs-mcp">GitHub</a>
                </nav>
            </div>
        </div>
    </header>

    <main>
        <section class="hero">
            <div class="hero-left">
                <h1>Your records,<br><span class="hl">AI-powered</span></h1>
                <p>Discogs MCP is an open-source Model Context Protocol server that connects Claude and other AI assistants to your Discogs record collection. Search by genre, decade, or just tell it you want <strong>something for a rainy Sunday</strong>. Self-hosted on Cloudflare Workers \u2014 <strong>you bring your own Discogs API key</strong>.</p>
                <div class="cta-row">
                    <a href="https://github.com/rianvdm/discogs-mcp#-self-hosting" class="btn btn-primary">Self-Hosting Guide</a>
                    <a href="https://github.com/rianvdm/discogs-mcp" class="btn btn-secondary">View Source</a>
                </div>
            </div>
            <div class="hero-right">
                <div class="record"></div>
                <div class="now-spinning">Now spinning\u2026</div>
            </div>
        </section>

        <section class="notice">
            <div class="container">
                <p><strong>Heads up:</strong> <code>discogs-mcp.com</code> is the maintainer's private instance and is locked to a single Discogs account. The Discogs API rate limit is too tight to share, so you'll need to <a href="https://github.com/rianvdm/discogs-mcp#-self-hosting">deploy your own copy</a> (free on Cloudflare Workers, takes ~10 minutes).</p>
            </div>
        </section>

        <section class="queries">
            <div class="container">
                <h2>Things you can ask</h2>
                <div class="query-grid">
                    <div class="query-card featured">
                        <q>Something for a rainy Sunday afternoon</q>
                        <span>Mood-based recommendations from your actual collection <span class="mood-tag">NEW</span></span>
                    </div>
                    <div class="query-card">
                        <q>What jazz records do I own?</q>
                        <span>Searches your full Discogs library by genre, style, or artist</span>
                    </div>
                    <div class="query-card">
                        <q>How many records from the 70s do I have?</q>
                        <span>Collection statistics and breakdowns</span>
                    </div>
                    <div class="query-card">
                        <q>Tell me about this pressing of Kind of Blue</q>
                        <span>Detailed release info including label, year, and format</span>
                    </div>
                </div>
            </div>
        </section>

        <section class="setup" id="setup">
            <div class="container">
                <h2>Setup</h2>
                <p style="color: var(--text-muted); font-size: 0.95rem; margin-bottom: 24px;">Deploy your own Discogs MCP server, then point your AI client at it.</p>
                <div class="setup-list">
                    <div class="setup-card">
                        <h3>1. Deploy your own instance</h3>
                        <p>Clone the repo, add your Discogs API credentials, and deploy to Cloudflare Workers. The free tier is more than enough.</p>
                        <p><a href="https://github.com/rianvdm/discogs-mcp#-self-hosting" style="color: var(--yellow-dark); font-weight: 600;">Read the self-hosting guide \u2192</a></p>
                    </div>
                    <div class="setup-card">
                        <h3>2. Connect your MCP client</h3>
                        <p>Once deployed, you'll have a URL like <code style="display:inline;padding:2px 6px">https://discogs-mcp.&lt;your-subdomain&gt;.workers.dev/mcp</code>. Point your MCP client at that URL \u2014 the same instructions work in Claude Desktop, Claude Code, Cursor, Windsurf, OpenCode, and any other MCP-compatible client.</p>
                        <p>The full configuration snippets are in the <a href="https://github.com/rianvdm/discogs-mcp#6-connect-your-mcp-client" style="color: var(--yellow-dark); font-weight: 600;">README</a>.</p>
                    </div>
                </div>
            </div>
        </section>

        <section class="tools" id="tools">
            <div class="container">
                <h2>Available Tools</h2>
                <div class="tool-cols">
                    <div class="tool-col">
                        <h3>Public (no auth)</h3>
                        <ul>
                            <li>ping</li>
                            <li>server_info</li>
                            <li>auth_status</li>
                        </ul>
                    </div>
                    <div class="tool-col">
                        <h3>Search &amp; discovery</h3>
                        <ul>
                            <li>search_collection</li>
                            <li>get_release</li>
                            <li>get_collection_stats</li>
                            <li>get_recommendations</li>
                        </ul>
                    </div>
                    <div class="tool-col">
                        <h3>Collection management</h3>
                        <ul>
                            <li>add_to_collection</li>
                            <li>remove_from_collection</li>
                            <li>move_release</li>
                            <li>rate_release</li>
                        </ul>
                    </div>
                    <div class="tool-col">
                        <h3>Folders</h3>
                        <ul>
                            <li>list_folders</li>
                            <li>create_folder</li>
                            <li>edit_folder</li>
                            <li>delete_folder</li>
                        </ul>
                    </div>
                    <div class="tool-col">
                        <h3>Custom fields</h3>
                        <ul>
                            <li>list_custom_fields</li>
                            <li>edit_custom_field</li>
                        </ul>
                    </div>
                    <div class="tool-col">
                        <h3>Diagnostics</h3>
                        <ul>
                            <li>get_cache_stats</li>
                        </ul>
                    </div>
                </div>
            </div>
        </section>
    </main>

    <footer>
        <div class="container">
            <div class="footer-links">
                <a href="https://github.com/rianvdm/discogs-mcp">Source Code</a>
                <a href="https://github.com/rianvdm/discogs-mcp#readme">Documentation</a>
                <a href="https://github.com/rianvdm/discogs-mcp/releases">Release Notes</a>
                <a href="https://github.com/rianvdm/discogs-mcp/issues">Report a Bug</a>
            </div>
            <p class="footer-note">
                Open source under MIT. Built on <a href="https://www.discogs.com/developers">Discogs API</a> and <a href="https://modelcontextprotocol.io">MCP</a>.
            </p>
        </div>
    </footer>

    <script>
        function copyCode(btn) {
            const code = btn.previousElementSibling.textContent;
            navigator.clipboard.writeText(code).then(() => {
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = 'Copy';
                    btn.classList.remove('copied');
                }, 2000);
            });
        }
    </script>
</body>
</html>`
