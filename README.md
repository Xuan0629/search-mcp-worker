# search-mcp-worker

A Cloudflare Worker that provides an MCP (Model Context Protocol) search aggregation service.

## Features

- **42+ search tools** aggregated behind a single MCP endpoint
- **Smart routing** — automatic language detection and intent-based engine selection
- **Chinese-first** — native Chinese search via Bocha API + Baidu + Sogou + Bing CN
- **Academic** — arXiv, PubMed, CrossRef, Semantic Scholar
- **Developer** — GitHub, StackExchange, npm, PyPI, crates.io
- **Free** — all sources are free (HTML scraping + public APIs)
- **MCP Protocol** — JSON-RPC 2.0, compatible with any MCP client

## Quick Start

```bash
# Install dependencies
npm install

# Local development
npm run dev

# Deploy to Cloudflare Workers
npm run deploy
```

## MCP Endpoint

```
POST https://search-mcp-worker.<your-subdomain>.workers.dev/mcp
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOCHA_API_KEY` | Yes | Bocha search API key |

Set via: `wrangler secret put BOCHA_API_KEY`

## Tech Stack

- **TypeScript** — type-safe development
- **Hono** — lightweight HTTP framework for Cloudflare Workers
- **Cloudflare Workers** — edge deployment
- **MCP Protocol** — Model Context Protocol (2025-03-26)
