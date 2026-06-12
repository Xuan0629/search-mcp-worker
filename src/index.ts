import { Hono } from 'hono';
import type { Env, JsonRpcRequest, JsonRpcResponse, McpToolResult, SearchResult, SearchResponse } from './types';
import { DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT } from './constants';
import { handleInitialize, handleToolsList, handlePing, makeError, makeToolResult, makeToolError } from './mcp/protocol';
import type { ToolHandler } from './mcp/protocol';
import { route, routeExplicit } from './router';
import { SearchCache, makeCacheKey } from './cache';
import { processResults } from './scorer';
import {
  isEngineFrozen,
  recordEngineSuccess,
  recordEngineBlocked,
  getCircuitState,
} from './circuit-breaker';
import { recordEngineHealthEvent, getEngineHealthStats } from './engine-health';
import { parseSiteTargetQuery, filterBySiteTarget } from './site-target';
// Engine modules are loaded lazily via dynamic import() in executeEngine,
// so each engine's HTML parser, regex, and helper code only lands in the
// workerd bundle when at least one request actually needs that engine.
//
// Type-only imports are fine at the top because TypeScript erases them:
// they have no runtime cost.
import type * as BochaEngine from './engines/bocha';
import type * as DuckDuckGoEngine from './engines/duckduckgo';
import type * as BingEngine from './engines/bing';
import type * as BaiduEngine from './engines/baidu';
import type * as SogouEngine from './engines/sogou';
import type * as AcademicEngine from './engines/academic';
import type * as DeveloperEngine from './engines/developer';
import type * as ReferenceEngine from './engines/reference';
import type * as GoogleEngine from './engines/google';
import type * as FetchEngine from './engines/fetch';

// ============================================================
// Lazy Engine Loader
// ============================================================
//
// Per-engine dynamic import() with a per-isolate cache. We hoist this
// onto globalThis for the same reason the circuit-breaker and engine-health
// modules do: dynamic import() is not free, so we don't want every request
// to re-run the module fetch. Subsequent requests in the same isolate hit
// the cache and skip the import.
//
// The cache is module-name keyed (not request-keyed): we only ever import
// an engine module the first time a request actually needs it. After that,
// every subsequent request hits the cache.
//
// Caveat for Cloudflare Workers: wrangler's default esbuild config inlines
// all `import()` targets into a single bundle, so the *shipping* bundle
// size is unchanged by this refactor. The win is real for any non-bundled
// runtime (Node ESM, vitest), and the dynamic-import shape leaves the door
// open for future per-worker split with `[build.bundle = "esbuild" --splitting]`
// or service-bindings.
const ENGINE_CACHE_KEY = '__search_mcp_engine_cache__';
type EngineCache = {
  bocha?: typeof BochaEngine;
  duckduckgo?: typeof DuckDuckGoEngine;
  bing?: typeof BingEngine;
  baidu?: typeof BaiduEngine;
  sogou?: typeof SogouEngine;
  academic?: typeof AcademicEngine;
  developer?: typeof DeveloperEngine;
  reference?: typeof ReferenceEngine;
  google?: typeof GoogleEngine;
  fetch?: typeof FetchEngine;
};
const g = globalThis as typeof globalThis & { [ENGINE_CACHE_KEY]?: EngineCache };
const engineCache: EngineCache = g[ENGINE_CACHE_KEY] ?? (g[ENGINE_CACHE_KEY] = {});

/** Resolve a single engine module, importing it on first use and caching
 * the result for subsequent requests in the same isolate. */
async function loadEngine<K extends keyof EngineCache>(name: K): Promise<NonNullable<EngineCache[K]>> {
  if (!engineCache[name]) {
    engineCache[name] = (await import(
      name === 'bocha'      ? './engines/bocha' :
      name === 'duckduckgo' ? './engines/duckduckgo' :
      name === 'bing'       ? './engines/bing' :
      name === 'baidu'      ? './engines/baidu' :
      name === 'sogou'      ? './engines/sogou' :
      name === 'academic'   ? './engines/academic' :
      name === 'developer'  ? './engines/developer' :
      name === 'reference'  ? './engines/reference' :
      name === 'google'     ? './engines/google' :
                              './engines/fetch'
    )) as EngineCache[K];
  }
  return engineCache[name]!;
}

/** Test-only: clear the engine cache. */
export function _resetEngineCache(): void {
  for (const k of Object.keys(engineCache)) delete (engineCache as Record<string, unknown>)[k];
}

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
  engines: getEngineHealthStats(),
  circuit_breakers: getCircuitState(),
}));

app.get('/healthz', (c) => c.json({
  status: 'ok',
  engines: getEngineHealthStats(),
  circuit_breakers: getCircuitState(),
}));

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
    const originalQuery = String(args.query);
    const limit = clampLimit(args.limit);
    const autoMode = String(args.auto_mode || 'quick');
    const explicitEngines = args.engines as string[] | undefined;

    // `site:example.com query` — strip the operator and remember the target host.
    const siteTarget = parseSiteTargetQuery(originalQuery);
    const query = siteTarget ? siteTarget.query : originalQuery;

    const routing = explicitEngines
      ? routeExplicit(explicitEngines, query, DISABLED_ENGINES)
      : route(query, DISABLED_ENGINES);

    // Check cache (key includes both originalQuery and site target so that
    // `site:gh.com foo` and `foo` don't collide).
    const cacheKey = makeCacheKey(originalQuery, routing.engines, limit);
    const cached = cache.get(cacheKey);
    if (cached) {
      return formatSearchResponse(cached, routing);
    }

    // Execute engines (skipping any that are circuit-broken)
    const allResults: SearchResult[] = [];
    const attempted: string[] = [];
    const skipped: string[] = [];

    for (const engineName of routing.engines) {
      if (isEngineFrozen(engineName)) {
        skipped.push(engineName);
        continue;
      }
      try {
        const results = await executeEngine(engineName, query, limit, args, env);
        attempted.push(engineName);

        // If site: was set, drop results that aren't on the target host.
        const filtered = siteTarget
          ? filterBySiteTarget(results, siteTarget.host)
          : results;

        allResults.push(...filtered);

        // Quick mode: stop after first engine that produced usable results
        if (autoMode === 'quick' && filtered.length > 0) break;
      } catch {
        attempted.push(engineName);
        continue;
      }
    }

    const processed = processResults(allResults, query, limit);
    const response: SearchResponse = {
      results: processed,
      query: originalQuery,
      engines: attempted,
      cached: false,
    };

    cache.set(cacheKey, response);
    return formatSearchResponse(response, routing);
  },

  // ---- Individual Engine Tools ----
  'search_bocha': async (args, env) => singleEngine('bocha', args, env),
  'search_bocha_ai': async (args, env) => {
    const { searchBochaAI } = await loadEngine('bocha');
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
    const { searchDDGInstantAnswer } = await loadEngine('reference');
    const results = await searchDDGInstantAnswer(String(args.query));
    if (results.length === 0) return makeToolResult('No instant answer found.');
    return makeToolResult(formatResults(results), results);
  },

  // ---- Fetch Tools ----
  'fetch_url': async (args, _env) => {
    const { fetchUrl } = await loadEngine('fetch');
    const url = String(args.url);
    const maxChars = Number(args.maxChars) || 12000;
    const result = await fetchUrl(url, maxChars);
    return makeToolResult(`# ${result.title}\n\nURL: ${result.url}\n\n${result.content}`, result);
  },
  'fetch_github_file': async (args, _env) => {
    const { fetchGitHubFile } = await loadEngine('fetch');
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
    const { findRss } = await loadEngine('fetch');
    const feeds: Array<{ title: string; url: string; type: string }> = await findRss(String(args.url));
    if (feeds.length === 0) return makeToolResult('No RSS/Atom feeds found.');
    const text = feeds.map((f: { title: string; url: string; type: string }) => `- [${f.title}](${f.url}) (${f.type})`).join('\n');
    return makeToolResult(text, feeds);
  },
};

// ============================================================
// Engine Execution
// ============================================================

/** Engines that should be skipped without even being called.
 *
 * Use this as a kill-switch when an upstream is down or its API key is
 * exhausted, so we don't waste a request's timeout budget on a known-bad
 * engine. Unlike the circuit breaker (which is per-isolate and not
 * reliable across requests on Cloudflare Workers), this is a hard
 * static switch — it always wins.
 *
 * Current state:
 *   - `bocha` — disabled. Bocha API key has been returning 403 consistently
 *     (see SKILL.md §252-253 for original report — quota exhausted).
 *     Re-enable by removing the entry from this set once the key is
 *     rotated and quota restored.
 */
const DISABLED_ENGINES: ReadonlySet<string> = new Set(['bocha']);

async function executeEngine(
  engineName: string,
  query: string,
  limit: number,
  args: Record<string, unknown>,
  env: Env,
): Promise<SearchResult[]> {
  // Hard kill-switch: an engine listed in DISABLED_ENGINES is never called,
  // even by `search_bocha` / `search_bocha_ai` direct tool calls.
  if (DISABLED_ENGINES.has(engineName)) {
    recordEngineHealthEvent(engineName, 'error');
    throw new Error(`engine '${engineName}' is disabled (see DISABLED_ENGINES in index.ts)`);
  }
  // Circuit breaker: skip engines that are currently frozen so a single
  // tool call doesn't waste its whole timeout budget on a known-bad engine.
  if (isEngineFrozen(engineName)) {
    recordEngineHealthEvent(engineName, 'error');
    throw new Error(`engine '${engineName}' is circuit-broken; try again later`);
  }
  try {
    // Resolve the engine module on first use; subsequent requests in
    // the same isolate hit the cache and skip the import.
    let results: SearchResult[] = [];
    switch (engineName) {
      case 'bocha':         { const m = await loadEngine('bocha');      results = await m.searchBocha(query, limit, env); break; }
      case 'duckduckgo':    { const m = await loadEngine('duckduckgo'); results = await m.searchDuckDuckGo(query, limit, String(args.region || 'us-en')); break; }
      case 'bing':          { const m = await loadEngine('bing');       results = await m.searchBing(query, limit); break; }
      case 'bing_cn':       { const m = await loadEngine('bing');       results = await m.searchBingCN(query, limit); break; }
      case 'google':        { const m = await loadEngine('google');     results = await m.searchGoogle(query, limit); break; }
      case 'baidu':         { const m = await loadEngine('baidu');      results = await m.searchBaidu(query, limit); break; }
      case 'sogou':         { const m = await loadEngine('sogou');      results = await m.searchSogou(query, limit); break; }
      case 'arxiv':         { const m = await loadEngine('academic');   results = await m.searchArxiv(query, limit); break; }
      case 'pubmed':        { const m = await loadEngine('academic');   results = await m.searchPubMed(query, limit); break; }
      case 'crossref':      { const m = await loadEngine('academic');   results = await m.searchCrossRef(query, limit); break; }
      case 'github':        { const m = await loadEngine('developer');  results = await m.searchGitHub(query, limit); break; }
      case 'stackexchange': { const m = await loadEngine('developer');  results = await m.searchStackExchange(query, limit, String(args.site || 'stackoverflow')); break; }
      case 'npm':           { const m = await loadEngine('developer');  results = await m.searchNpm(query, limit); break; }
      case 'pypi':          { const m = await loadEngine('developer');  results = await m.searchPyPI(query, limit); break; }
      case 'crates':        { const m = await loadEngine('developer');  results = await m.searchCrates(query, limit); break; }
      case 'hackernews':    { const m = await loadEngine('developer');  results = await m.searchHackerNews(query, limit); break; }
      case 'wikipedia':     { const m = await loadEngine('reference');  results = await m.searchWikipedia(query, limit, String(args.language || 'en')); break; }
      case 'wikidata':      { const m = await loadEngine('reference');  results = await m.searchWikidata(query, limit); break; }
      case 'ddg_instant':   { const m = await loadEngine('reference');  results = await m.searchDDGInstantAnswer(query); break; }
      default:              results = [];
    }
    if (results.length > 0) recordEngineSuccess(engineName);
    recordEngineHealthEvent(engineName, results.length > 0 ? 'success' : 'empty');
    return results;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'failed';
    recordEngineHealthEvent(engineName, 'error');
    if (isBlockedReason(reason)) {
      recordEngineBlocked(engineName, reason);
    }
    throw err;
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

/**
 * Decide whether an engine error message looks like an anti-bot / quota
 * blocked signal (4xx, 5xx, CAPTCHA, 403/202 with challenge markers).
 * If true, the circuit breaker should count it as a failure that
 * contributes toward freezing the engine.
 *
 * Conservative on purpose: we only match clear signals so that transient
 * network blips (TypeError, fetch failed, etc.) do NOT trip the breaker.
 */
function isBlockedReason(reason: string): boolean {
  const r = reason.toLowerCase();
  if (r.includes('captcha') || r.includes('challenge')) return true;
  // HTTP status codes that indicate blocking / anti-bot
  if (/\b(403|429|503)\b/.test(r)) return true;
  // Bocha's quota-exhausted 401 / generic 401
  if (/\b401\b/.test(r) && (r.includes('quota') || r.includes('exhaust') || r.includes('limit'))) {
    return true;
  }
  // 202 with empty body is a CF challenge signal in fetchUrl
  if (r.includes('202') && (r.includes('empty') || r.includes('challenge'))) return true;
  return false;
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
