// ============================================================
// search-mcp-worker — Constants
// ============================================================

import type { EngineConfig } from './types';

// MCP Protocol
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const MCP_SERVER_NAME = 'search-mcp-worker';
export const MCP_SERVER_VERSION = '0.1.0';

// Timeouts
export const DEFAULT_TIMEOUT_MS = 12_000;
export const ACADEMIC_TIMEOUT_MS = 20_000;
export const FETCH_TIMEOUT_MS = 15_000;

// Fetch limits
export const MAX_FETCH_BYTES = 512 * 1024;         // 512 KB
export const DEFAULT_MAX_CHARS = 12_000;
export const MAX_URL_CHARS = 30_000;
export const DEFAULT_GITHUB_FILE_CHARS = 20_000;
export const MAX_GITHUB_FILE_CHARS = 50_000;

// Cache
export const CACHE_TTL_MS = 5 * 60 * 1000;         // 5 minutes
export const CACHE_MAX_ENTRIES = 200;

// Circuit Breaker
// After CIRCUIT_BREAKER_THRESHOLD blocked responses, the engine is skipped
// for CIRCUIT_BREAKER_FREEZE_MS to avoid hammering it during transient
// anti-bot / quota-exhausted windows.
export const CIRCUIT_BREAKER_THRESHOLD = 3;
export const CIRCUIT_BREAKER_FREEZE_MS = 5 * 60 * 1000;  // 5 minutes

// Engine health event window (for /health stats)
export const ENGINE_HEALTH_WINDOW_MS = 60 * 60 * 1000;   // 1 hour

// Search race-pattern wall-clock budget.
// The 'search' tool runs all selected engines concurrently and waits
// up to this long for them to settle. After the timeout fires, we
// process whatever results we have and surface the rest as 'engines_skipped'
// in _meta so the caller knows the response is partial. Setting this
// lower reduces tail latency for users; setting it higher gives engines
// more time to return useful results. The default (8s) is well under
// the workerd 30s wall-clock limit and well over the typical 1-2s
// Bing/DDG response time.
export const SEARCH_RACE_TIMEOUT_MS = 8_000;

// `site:example.com query` operator
export const SITE_TARGET_PATTERN = /^\s*site:([^\s/]+)\s+(.+)$/i;

// Intent mismatch hard filter
// CJK sub-token coverage below this fraction is treated as a hard mismatch
// and the result is dropped, not just penalised. Borrowed heuristic from
// Kerry1020/search-mcp-worker (re-derived, not vendored).
export const CJK_INTENT_COVERAGE_MIN = 0.15;

// Results
export const DEFAULT_RESULT_LIMIT = 5;
export const MAX_RESULT_LIMIT = 10;

// Scoring weights
export const SCORE_QUALITY_GREEN = 220;
export const SCORE_QUALITY_YELLOW = 110;
export const SCORE_RANK_BASE = 30;
export const SCORE_RANK_DECAY = 3;
export const SCORE_MULTI_SOURCE_BONUS = 40;
export const SCORE_TOKEN_MATCH_BONUS = 8;
export const SCORE_OFFICIAL_DOMAIN_BONUS = 35;
export const SCORE_GENERIC_WRAPPER_PENALTY = -60;
export const SCORE_INTENT_MISMATCH_PENALTY = -80;
export const SCORE_LOW_TRUST_PENALTY = -120;

// Official domains for bonus scoring
export const OFFICIAL_DOMAINS = [
  '.gov', '.edu', '.org', '.ac.cn', '.edu.cn',
  'github.com', 'stackoverflow.com', 'npmjs.com',
  'pypi.org', 'crates.io', 'arxiv.org',
  'wikipedia.org', 'wikidata.org',
];

// Low-trust signals
export const LOW_TRUST_TLDS = ['.xyz', '.top', '.click', '.buzz', '.info', '.loan', '.work', '.date'];
export const LOW_TRUST_SUBDOMAIN_PATTERNS = [/^\d{4}[-.]/, /^www\d+\./];

// User agents for HTML scraping rotation.
//
// A mix of mobile (Android Chrome + iPhone Safari) and desktop
// (macOS Chrome, macOS Safari, Windows Firefox) agents, since some
// upstream anti-bot systems whitelist one bucket more than the
// other. Picking from this pool per request (via randomUserAgent()
// in src/utils/http.ts) avoids the "every request uses the same UA
// → flag pattern" problem that fixed worker UAs run into.
//
// The actual pool contents were tuned during v0.1.0 (see ed291a2);
// the desktop variants were added in this commit.
export const USER_AGENTS = [
  // Mobile Chrome (Android Pixel / Samsung / Xiaomi) — primary.
  // Some upstream sites (notably Google) only serve full content
  // to mobile UAs; the desktop agents in the pool were degrading
  // result quality in production testing, so they're temporarily
  // out. See test/random-user-agent.test.ts for the assertion
  // that at least one mobile UA stays in the pool.
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; M2101K6G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
  // Mobile Safari (iPhone)
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
];

// Engine categories for routing
export const ENGINE_REGISTRY: Record<string, EngineConfig> = {
  bocha:           { name: 'bocha',           displayName: 'Bocha',            category: 'chinese',   languages: ['zh', 'en'], timeout: 8000,  maxResults: 10, requiresApiKey: true,  apiKeyEnvVar: 'BOCHA_API_KEY' },
  baidu:           { name: 'baidu',           displayName: 'Baidu',            category: 'chinese',   languages: ['zh'],       timeout: 10000, maxResults: 10, requiresApiKey: false },
  sogou:           { name: 'sogou',           displayName: 'Sogou',            category: 'chinese',   languages: ['zh'],       timeout: 10000, maxResults: 10, requiresApiKey: false },
  bing_cn:         { name: 'bing_cn',         displayName: 'Bing CN',          category: 'chinese',   languages: ['zh'],       timeout: 10000, maxResults: 10, requiresApiKey: false },
  duckduckgo:      { name: 'duckduckgo',      displayName: 'DuckDuckGo',       category: 'general',   languages: ['en', 'any'],timeout: 12000, maxResults: 10, requiresApiKey: false },
  bing:            { name: 'bing',            displayName: 'Bing',             category: 'general',   languages: ['en', 'any'],timeout: 12000, maxResults: 10, requiresApiKey: false },
  google:          { name: 'google',          displayName: 'Google',           category: 'general',   languages: ['any'],      timeout: 12000, maxResults: 10, requiresApiKey: false },
  arxiv:           { name: 'arxiv',           displayName: 'arXiv',            category: 'academic',  languages: ['en', 'any'],timeout: 20000, maxResults: 10, requiresApiKey: false },
  pubmed:          { name: 'pubmed',          displayName: 'PubMed',           category: 'academic',  languages: ['en'],       timeout: 20000, maxResults: 10, requiresApiKey: false },
  crossref:        { name: 'crossref',        displayName: 'CrossRef',         category: 'academic',  languages: ['en'],       timeout: 15000, maxResults: 10, requiresApiKey: false },
  github:          { name: 'github',          displayName: 'GitHub',           category: 'developer', languages: ['en', 'any'],timeout: 10000, maxResults: 10, requiresApiKey: false },
  stackexchange:   { name: 'stackexchange',   displayName: 'StackExchange',    category: 'developer', languages: ['en'],       timeout: 10000, maxResults: 10, requiresApiKey: false },
  npm:             { name: 'npm',             displayName: 'npm',              category: 'developer', languages: ['en'],       timeout: 8000,  maxResults: 10, requiresApiKey: false },
  pypi:            { name: 'pypi',            displayName: 'PyPI',             category: 'developer', languages: ['en'],       timeout: 8000,  maxResults: 10, requiresApiKey: false },
  crates:          { name: 'crates',           displayName: 'crates.io',        category: 'developer', languages: ['en'],       timeout: 8000,  maxResults: 10, requiresApiKey: false },
  wikipedia:       { name: 'wikipedia',       displayName: 'Wikipedia',        category: 'reference', languages: ['zh', 'en'], timeout: 8000,  maxResults: 10, requiresApiKey: false },
  wikidata:        { name: 'wikidata',        displayName: 'Wikidata',         category: 'reference', languages: ['any'],      timeout: 8000,  maxResults: 10, requiresApiKey: false },
  ddg_instant:     { name: 'ddg_instant',     displayName: 'DDG Instant Answer',category: 'reference',languages: ['any'],      timeout: 5000,  maxResults: 5,  requiresApiKey: false },
  hackernews:      { name: 'hackernews',      displayName: 'Hacker News',      category: 'developer', languages: ['en'],       timeout: 8000,  maxResults: 10, requiresApiKey: false },
};
