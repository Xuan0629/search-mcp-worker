import { Hono } from 'hono';
import type { Env, JsonRpcRequest, JsonRpcResponse, McpToolResult, SearchResult, SearchResponse } from './types';
import { DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT } from './constants';
import { handleInitialize, handleToolsList, handlePing, makeError, makeToolResult, makeToolError } from './mcp/protocol';
import type { ToolHandler } from './mcp/protocol';
import { route, routeExplicit } from './router';
import { SearchCache, makeCacheKey } from './cache';
import { processResults } from './scorer';
// Engines
import { searchBocha, searchBochaAI } from './engines/bocha';
import { searchDuckDuckGo } from './engines/duckduckgo';
import { searchBing, searchBingCN } from './engines/bing';
import { searchBaidu } from './engines/baidu';
import { searchSogou } from './engines/sogou';
import { searchArxiv, searchPubMed, searchCrossRef } from './engines/academic';
import { searchGitHub, searchStackExchange, searchNpm, searchPyPI, searchCrates, searchHackerNews } from './engines/developer';
import { searchWikipedia, searchWikidata, searchDDGInstantAnswer } from './engines/reference';
import { searchGoogle } from './engines/google';
import { fetchUrl, fetchGitHubFile, findRss } from './engines/fetch';

// ============================================================
// App
// ============================================================

const app = new Hono<{ Bindings: Env }>();
const cache = new SearchCache();

// ---- Health Check ----

app.get('/', (c) => c.json({
  status: 'ok',
  service: 'search-mcp-worker',
  version: '0.1.0',
  endpoint: '/mcp',
}));

app.get('/healthz', (c) => c.json({ status: 'ok' }));

// ---- CORS ----

app.options('/mcp', (c) =>
  c.text('', 200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
);

// ---- MCP Endpoint ----

app.post('/mcp', async (c) => {
  const env = c.env;
  let body: JsonRpcRequest | JsonRpcRequest[];

  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400, corsHeaders());
  }

  // Handle batch requests
  const requests = Array.isArray(body) ? body : [body];
  const responses = await Promise.all(requests.map(r => dispatchRequest(r, env)));

  const result = Array.isArray(body) ? responses : responses[0];
  return c.json(result, 200, corsHeaders());
});

// ============================================================
// Request Dispatch
// ============================================================

async function dispatchRequest(request: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
  switch (request.method) {
    case 'initialize':
      return handleInitialize(request);
    case 'notifications/initialized':
      return { jsonrpc: '2.0', id: request.id ?? null, result: {} };
    case 'ping':
      return handlePing(request);
    case 'tools/list':
      return handleToolsList(request);
    case 'tools/call':
      return handleToolCall(request, env);
    default:
      return makeError(request, -32601, `Method not found: ${request.method}`);
  }
}

// ============================================================
// Tool Call Handler
// ============================================================

async function handleToolCall(request: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
  const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const toolName = params.name;
  const args = params.arguments ?? {};

  if (!toolName) {
    return makeError(request, -32602, 'Missing tool name');
  }

  const handler = toolHandlers[toolName];
  if (!handler) {
    return makeError(request, -32602, `Unknown tool: ${toolName}`);
  }

  try {
    const result = await handler(args, env);
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: makeToolError(message),
    };
  }
}

// ============================================================
// Tool Handler Registry
// ============================================================

const toolHandlers: Record<string, ToolHandler> = {

  // ---- Smart Search ----
  'search': async (args, env) => {
    const query = String(args.query);
    const limit = clampLimit(args.limit);
    const autoMode = String(args.auto_mode || 'quick');
    const explicitEngines = args.engines as string[] | undefined;

    const routing = explicitEngines
      ? routeExplicit(explicitEngines, query)
      : route(query);

    // Check cache
    const cacheKey = makeCacheKey(query, routing.engines, limit);
    const cached = cache.get(cacheKey);
    if (cached) {
      return formatSearchResponse(cached, routing);
    }

    // Execute engines
    const allResults: SearchResult[] = [];
    const attempted: string[] = [];

    for (const engineName of routing.engines) {
      try {
        const results = await executeEngine(engineName, query, limit, args, env);
        attempted.push(engineName);
        allResults.push(...results);

        // Quick mode: stop after first successful engine
        if (autoMode === 'quick' && results.length > 0) break;
      } catch {
        attempted.push(engineName);
        continue;
      }
    }

    const processed = processResults(allResults, query, limit);
    const response: SearchResponse = {
      results: processed,
      query,
      engines: attempted,
      cached: false,
    };

    cache.set(cacheKey, response);
    return formatSearchResponse(response, routing);
  },

  // ---- Individual Engine Tools ----
  'search_bocha': async (args, env) => singleEngine('bocha', args, env),
  'search_bocha_ai': async (args, env) => {
    const query = String(args.query);
    const limit = clampLimit(args.limit);
    const { results, answer } = await searchBochaAI(query, limit, env);
    const processed = processResults(results, query, limit);
    const text = answer
      ? `## AI Answer\n\n${answer}\n\n## Sources\n${formatResults(processed)}`
      : formatResults(processed);
    return makeToolResult(text, processed);
  },
  'search_duckduckgo': async (args, _env) => singleEngine('duckduckgo', args, _env),
  'search_bing': async (args, _env) => singleEngine('bing', args, _env),
  'search_bing_cn': async (args, _env) => singleEngine('bing_cn', args, _env),
  'search_google': async (args, _env) => singleEngine('google', args, _env),
  'search_baidu': async (args, _env) => singleEngine('baidu', args, _env),
  'search_sogou': async (args, _env) => singleEngine('sogou', args, _env),
  'search_arxiv': async (args, _env) => singleEngine('arxiv', args, _env),
  'search_pubmed': async (args, _env) => singleEngine('pubmed', args, _env),
  'search_crossref': async (args, _env) => singleEngine('crossref', args, _env),
  'search_github': async (args, _env) => singleEngine('github', args, _env),
  'search_stackexchange': async (args, _env) => singleEngine('stackexchange', args, _env),
  'search_npm': async (args, _env) => singleEngine('npm', args, _env),
  'search_pypi': async (args, _env) => singleEngine('pypi', args, _env),
  'search_crates': async (args, _env) => singleEngine('crates', args, _env),
  'search_hackernews': async (args, _env) => singleEngine('hackernews', args, _env),
  'search_wikipedia': async (args, _env) => singleEngine('wikipedia', args, _env),
  'search_wikidata': async (args, _env) => singleEngine('wikidata', args, _env),
  'instant_answer': async (args, _env) => {
    const results = await searchDDGInstantAnswer(String(args.query));
    if (results.length === 0) return makeToolResult('No instant answer found.');
    return makeToolResult(formatResults(results), results);
  },

  // ---- Fetch Tools ----
  'fetch_url': async (args, _env) => {
    const url = String(args.url);
    const maxChars = Number(args.maxChars) || 12000;
    const result = await fetchUrl(url, maxChars);
    return makeToolResult(`# ${result.title}\n\nURL: ${result.url}\n\n${result.content}`, result);
  },
  'fetch_github_file': async (args, _env) => {
    const owner = String(args.owner);
    const repo = String(args.repo);
    const path = String(args.path);
    const ref = String(args.ref || 'main');
    const maxChars = Number(args.maxChars) || 20000;
    const result = await fetchGitHubFile(owner, repo, path, ref, maxChars);
    const truncated = result.size > maxChars ? ` (truncated from ${result.size} chars)` : '';
    return makeToolResult(`# ${result.path}\n\nURL: ${result.url}${truncated}\n\n${result.content}`, result);
  },
  'find_rss': async (args, _env) => {
    const feeds = await findRss(String(args.url));
    if (feeds.length === 0) return makeToolResult('No RSS/Atom feeds found.');
    const text = feeds.map(f => `- [${f.title}](${f.url}) (${f.type})`).join('\n');
    return makeToolResult(text, feeds);
  },
};

// ============================================================
// Engine Execution
// ============================================================

async function executeEngine(
  engineName: string,
  query: string,
  limit: number,
  args: Record<string, unknown>,
  env: Env,
): Promise<SearchResult[]> {
  switch (engineName) {
    case 'bocha': return searchBocha(query, limit, env);
    case 'duckduckgo': return searchDuckDuckGo(query, limit, String(args.region || 'us-en'));
    case 'bing': return searchBing(query, limit);
    case 'bing_cn': return searchBingCN(query, limit);
    case 'google': return searchGoogle(query, limit);
    case 'baidu': return searchBaidu(query, limit);
    case 'sogou': return searchSogou(query, limit);
    case 'arxiv': return searchArxiv(query, limit);
    case 'pubmed': return searchPubMed(query, limit);
    case 'crossref': return searchCrossRef(query, limit);
    case 'github': return searchGitHub(query, limit);
    case 'stackexchange': return searchStackExchange(query, limit, String(args.site || 'stackoverflow'));
    case 'npm': return searchNpm(query, limit);
    case 'pypi': return searchPyPI(query, limit);
    case 'crates': return searchCrates(query, limit);
    case 'hackernews': return searchHackerNews(query, limit);
    case 'wikipedia': return searchWikipedia(query, limit, String(args.language || 'en'));
    case 'wikidata': return searchWikidata(query, limit);
    case 'ddg_instant': return searchDDGInstantAnswer(query);
    default: return [];
  }
}

async function singleEngine(
  engineName: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent?: unknown }> {
  const query = String(args.query);
  const limit = clampLimit(args.limit);
  const results = await executeEngine(engineName, query, limit, args, env);
  const processed = processResults(results, query, limit);
  return makeToolResult(formatResults(processed), processed);
}

// ============================================================
// Response Formatting
// ============================================================

function formatSearchResponse(
  response: SearchResponse,
  routing: { engines: string[]; intent: string; language: string },
): McpToolResult {
  const header = `## Search Results\n\nQuery: "${response.query}" | Intent: ${routing.intent} | Lang: ${routing.language} | Engines: ${response.engines.join(', ')}${response.cached ? ' (cached)' : ''}`;
  const text = `${header}\n\n${formatResults(response.results)}`;
  return makeToolResult(text, response);
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';

  return results.map((r, i) => {
    let line = `${i + 1}. **${r.title}**`;
    line += `\n   URL: ${r.url}`;
    if (r.snippet) line += `\n   ${r.snippet}`;
    if (r.summary) line += `\n   📝 ${r.summary.slice(0, 200)}`;
    if (r.publishedDate) line += `\n   📅 ${r.publishedDate}`;
    if (r.source.includes(',')) line += `\n   📡 Sources: ${r.source}`;
    line += '\n';
    return line;
  }).join('\n');
}

// ============================================================
// Helpers
// ============================================================

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_RESULT_LIMIT;
  return Math.min(n, MAX_RESULT_LIMIT);
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ============================================================
// Export for Cloudflare Workers
// ============================================================

export default app;
