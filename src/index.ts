import { Hono } from 'hono';
import type { Env, JsonRpcRequest, JsonRpcResponse, McpToolResult, SearchResult, SearchResponse } from './types';
import { DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT, SEARCH_RACE_TIMEOUT_MS } from './constants';
import { handleInitialize, handleToolsList, handlePing, makeError, makeToolResult, makeToolError } from './mcp/protocol';
import type { ToolHandler } from './mcp/protocol';
import { route, routeExplicit } from './router';
import { SearchCache, makeCacheKey } from './cache';
import { processResults, processResultsWithStats } from './scorer';
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
// Secret Status
// ============================================================
//
// Helper for the /admin/secrets endpoint: report which Wrangler secrets
// are configured without ever calling the upstream. This is the cheap,
// zero-quota way to confirm that BOCHA_API_KEY was actually injected
// during `wrangler deploy` — the value itself is never read (it lives
// encrypted in the Worker runtime, accessible via c.env.BOCHA_API_KEY
// but never exposed to the response).
//
// Operators can hit /admin/secrets post-deploy and immediately see if a
// key is missing, without having to call an MCP tool that would waste
// the Bocha API quota to discover the same thing.

function getSecretStatus(env: Env): Record<string, 'set' | 'missing' | 'disabled'> {
  // DISABLED_ENGINES determines which engines we even *try* to call.
  // If a key is set but the engine is disabled, the user doesn't care.
  // Conversely, an engine NOT in DISABLED_ENGINES but with a missing key
  // would 100% fail at runtime, so we surface that explicitly.
  const out: Record<string, 'set' | 'missing' | 'disabled'> = {};

  // Bocha is currently disabled (see DISABLED_ENGINES below) because the
  // upstream API key has been returning 403 consistently. Once it's
  // re-enabled, remove the 'disabled' entry here and add the key check.
  out.BOCHA_API_KEY = DISABLED_ENGINES.has('bocha') ? 'disabled' :
                       env.BOCHA_API_KEY ? 'set' : 'missing';

  return out;
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
  secrets: getSecretStatus(c.env),
}));

app.get('/healthz', (c) => c.json({
  status: 'ok',
  engines: getEngineHealthStats(),
  circuit_breakers: getCircuitState(),
}));

app.get('/admin/secrets', (c) => c.json({
  secrets: getSecretStatus(c.env),
  // Echo the disabled set so operators can correlate 'disabled' status
  // with the static config in one place.
  disabled_engines: Array.from(DISABLED_ENGINES),
  // Echo health stats so the operator doesn't have to hit a second
  // endpoint to see why an engine might be in 'set' but still failing.
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
      return formatSearchResponse(cached, routing, { cache_hit: true });
    }

    // Race-pattern engine execution: fire all selected engines
    // concurrently and wait up to SEARCH_RACE_TIMEOUT_MS for the
    // slow ones to settle. Engines that haven't returned by the
    // deadline are still tracked as 'attempted' (their promise is
    // still in flight) but won't contribute results to this response.
    //
    // Why race and not the previous serial for-loop:
    // - Serial: a slow Bing response (12s timeout) blocks Sogou,
    //   Baidu, etc., even when Bing returns 0 results at the 12s mark.
    //   For a 'search' tool where quick results are the priority,
    //   serial execution wastes the user's wall-clock time.
    // - Race: all engines fire in parallel, we get Bing's 1.2s
    //   response + DDG's 0.8s response + ... well within the
    //   8s budget. The timeout is the wall-clock cap, not a
    //   per-engine cap; per-engine timeouts are still set on
    //   individual fetch() calls inside each engine.
    //
    // We use Promise.race with a sentinel rather than racing against
    // allSettled so that the slow stragglers don't drag out the
    // response past the timeout. Once the timeout fires we treat any
    // engine whose promise hasn't settled as "attempted but timed out";
    // their in-flight fetches are NOT cancelled (workerd doesn't
    // support cancelling an in-flight fetch), but the response goes
    // out on time. The stragglers finish in the background and their
    // results are discarded.
    const allResults: SearchResult[] = [];
    const attempted: string[] = [];
    const timedOut: string[] = [];
    const liveEngines = routing.engines.filter((e) => !isEngineFrozen(e));
    const skipped = routing.engines.filter((e) => isEngineFrozen(e));

    type Settled = { engine: string; results: SearchResult[] } | { engine: string; error: string };

    // Wait for all engines to settle OR the wall-clock timeout to
    // fire, whichever comes first. We use a custom settled-flag
    // pattern because the native Promise API has no way to ask
    // "which of these N promises have settled already" — Promise.allSettled
    // always waits for all of them, and Promise.race only gives you
    // the first one. So each work item flips its flag when it
    // settles, and after the race we read the flags to know which
    // engines contributed results.
    const settledFlags: boolean[] = liveEngines.map(() => false);
    const workResults: Settled[] = liveEngines.map(() => ({ engine: '', error: 'never-ran' }));
    const work: Promise<void>[] = liveEngines.map(async (engineName, i) => {
      try {
        const results = await executeEngine(engineName, query, limit, args, env);
        const filtered = siteTarget ? filterBySiteTarget(results, siteTarget.host) : results;
        workResults[i] = { engine: engineName, results: filtered };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'failed';
        workResults[i] = { engine: engineName, error: message };
      } finally {
        settledFlags[i] = true;
      }
    });

    const settled = await Promise.race([
      Promise.all(work).then(() => ({ kind: 'done' as const })),
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), SEARCH_RACE_TIMEOUT_MS),
      ),
    ]);

    // Walk the flags. Any work item that flipped its flag is "settled";
    // anything else is treated as timed out and we stop waiting.
    for (let i = 0; i < liveEngines.length; i++) {
      const engineName = liveEngines[i];
      attempted.push(engineName);
      if (settledFlags[i]) {
        const v = workResults[i];
        if ('results' in v) {
          allResults.push(...v.results);
        }
        // Errors are already recorded by executeEngine into the
        // health/circuit-breaker stats; we just don't include the
        // engine in the result set.
      } else {
        timedOut.push(engineName);
      }
    }
    // (settled.kind is unused beyond telling us if the race finished;
    // the flags array is the source of truth.)

    const { results: processed, stats } = processResultsWithStats(allResults, query, limit);
    const response: SearchResponse = {
      results: processed,
      query: originalQuery,
      engines: attempted,
      cached: false,
    };

    cache.set(cacheKey, response);
    return formatSearchResponse(response, routing, {
      cache_hit: false,
      filtered_count: stats.filtered_count,
      filter_reason: stats.filter_reason ?? undefined,
      skipped_engines: [...skipped, ...timedOut],
      timed_out_engines: timedOut,
    });
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
  meta?: { filtered_count?: number; filter_reason?: string; skipped_engines?: string[]; cache_hit?: boolean; timed_out_engines?: string[] },
): McpToolResult {
  const header = `## Search Results\n\nQuery: "${response.query}" | Intent: ${routing.intent} | Lang: ${routing.language} | Engines: ${response.engines.join(', ')}${response.cached ? ' (cached)' : ''}`;
  const text = `${header}\n\n${formatResults(response.results)}`;
  // structuredContent now carries both the full SearchResponse (for
  // backwards-compatibility with callers that read it directly) and a
  // `_meta` block with per-request health/pipeline observability. The
  // OpenClaw observer pipeline reads `_meta` to decide whether to
  // cross-reference with another search tool (e.g. when filter_reason
  // is 'intent_mismatch' suggesting the engine did parse but the
  // results were off-topic).
  const structured = {
    ...response,
    _meta: {
      intent: routing.intent,
      language: routing.language,
      engines_attempted: response.engines,
      engines_skipped: meta?.skipped_engines ?? [],
      engines_timed_out: meta?.timed_out_engines ?? [],
      cache_hit: meta?.cache_hit ?? response.cached,
      filtered_count: meta?.filtered_count ?? 0,
      filter_reason: meta?.filter_reason ?? null,
      timestamp: new Date().toISOString(),
    },
  };
  return makeToolResult(text, structured);
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
