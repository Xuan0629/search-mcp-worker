import type { JsonRpcRequest, JsonRpcResponse, JsonRpcError, McpTool, McpToolResult, Env } from '../types';
import { MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../constants';

// ---- Tool Definitions ----

export function getToolList(): McpTool[] {
  return [
    // === Smart Auto Search ===
    {
      name: 'search',
      description: 'Smart search — automatically detects language and intent, then selects the best search engines. Supports Chinese and English queries. Use this as the default search tool.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (supports natural language, Chinese and English)' },
          limit: { type: 'number', description: 'Max results (1-10)', default: 5, minimum: 1, maximum: 10 },
          engines: { type: 'array', items: { type: 'string' }, description: 'Override auto-selected engines. Available: bocha, baidu, sogou, bing_cn, duckduckgo, bing, google, arxiv, pubmed, crossref, github, stackexchange, npm, pypi, crates, hackernews, wikipedia, wikidata, ddg_instant' },
          auto_mode: { type: 'string', enum: ['quick', 'full'], description: '"quick" = stop after first engine returns results; "full" = try all selected engines for comprehensive coverage', default: 'quick' },
        },
        required: ['query'],
      },
    },
    // === General Search ===
    {
      name: 'search_duckduckgo',
      description: 'Search DuckDuckGo (HTML scraping, free, English-focused)',
      inputSchema: querySchema({ region: { type: 'string', description: 'Region code (e.g. us-en, wt-wt)', default: 'us-en' } }),
    },
    {
      name: 'search_bing',
      description: 'Search Bing (HTML scraping, free, English)',
      inputSchema: querySchema(),
    },
    {
      name: 'search_bing_cn',
      description: 'Search Bing China (HTML scraping, free, Chinese results)',
      inputSchema: querySchema(),
    },
    {
      name: 'search_google',
      description: 'Search Google (PLACEHOLDER — frequently blocked by CAPTCHA. Use DuckDuckGo/Bing/Bocha instead.)',
      inputSchema: querySchema(),
    },
    // === Chinese Search ===
    {
      name: 'search_bocha',
      description: 'Search via Bocha API — high-quality Chinese/English search with AI summaries. Best for Chinese queries.',
      inputSchema: querySchema(),
    },
    {
      name: 'search_bocha_ai',
      description: 'Search via Bocha AI Search — returns web results + AI-generated answer with source citations. Best for questions.',
      inputSchema: querySchema(),
    },
    {
      name: 'search_baidu',
      description: 'Search Baidu (free, Chinese-focused, JSON API + HTML fallback)',
      inputSchema: querySchema(),
    },
    {
      name: 'search_sogou',
      description: 'Search Sogou (free, Chinese-focused, HTML scraping)',
      inputSchema: querySchema(),
    },
    // === Academic Search ===
    {
      name: 'search_arxiv',
      description: 'Search arXiv preprints — physics, math, CS, AI/ML papers',
      inputSchema: querySchema(),
    },
    {
      name: 'search_pubmed',
      description: 'Search PubMed — biomedical and life sciences literature',
      inputSchema: querySchema(),
    },
    {
      name: 'search_crossref',
      description: 'Search CrossRef — academic papers and publications via DOI metadata',
      inputSchema: querySchema(),
    },
    // === Developer Search ===
    {
      name: 'search_github',
      description: 'Search GitHub repositories (sorted by stars)',
      inputSchema: querySchema(),
    },
    {
      name: 'search_stackexchange',
      description: 'Search StackExchange sites (StackOverflow, ServerFault, etc.)',
      inputSchema: querySchema({ site: { type: 'string', description: 'StackExchange site (stackoverflow, serverfault, askubuntu, etc.)', default: 'stackoverflow' } }),
    },
    {
      name: 'search_npm',
      description: 'Search npm packages',
      inputSchema: querySchema(),
    },
    {
      name: 'search_pypi',
      description: 'Search PyPI Python packages',
      inputSchema: querySchema(),
    },
    {
      name: 'search_crates',
      description: 'Search crates.io Rust packages',
      inputSchema: querySchema(),
    },
    {
      name: 'search_hackernews',
      description: 'Search Hacker News stories',
      inputSchema: querySchema(),
    },
    // === Reference ===
    {
      name: 'search_wikipedia',
      description: 'Search Wikipedia (English or Chinese)',
      inputSchema: querySchema({ language: { type: 'string', description: 'Language code (en, zh)', default: 'en' } }),
    },
    {
      name: 'search_wikidata',
      description: 'Search Wikidata entities',
      inputSchema: querySchema(),
    },
    {
      name: 'instant_answer',
      description: 'Get instant answers from DuckDuckGo (definitions, facts, disambiguation)',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Query for instant answer' },
        },
        required: ['query'],
      },
    },
    // === Fetch Tools ===
    {
      name: 'fetch_url',
      description: 'Fetch and extract text content from a URL. Strips HTML to plain text.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          maxChars: { type: 'number', description: 'Max characters to return (1000-30000)', default: 12000, minimum: 1000, maximum: 30000 },
        },
        required: ['url'],
      },
    },
    {
      name: 'fetch_github_file',
      description: 'Fetch a file from a GitHub repository via raw.githubusercontent.com',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          path: { type: 'string', description: 'File path within the repository' },
          ref: { type: 'string', description: 'Git ref (branch, tag, commit)', default: 'main' },
          maxChars: { type: 'number', description: 'Max characters (1000-50000)', default: 20000, minimum: 1000, maximum: 50000 },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
    {
      name: 'find_rss',
      description: 'Discover RSS/Atom feed URLs from a webpage',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL of the page to discover feeds from' },
        },
        required: ['url'],
      },
    },
  ];
}

// ---- Schema Helpers ----

function querySchema(extra?: Record<string, unknown>): McpTool['inputSchema'] {
  const properties: Record<string, unknown> = {
    query: { type: 'string', description: 'Search query' },
    limit: { type: 'number', description: 'Max results (1-10)', default: 5, minimum: 1, maximum: 10 },
    ...extra,
  };
  return {
    type: 'object',
    properties,
    required: ['query'],
  };
}

// ---- MCP Protocol Handler ----

export function handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      },
    },
  };
}

export function handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    result: {
      tools: getToolList(),
    },
  };
}

export function handlePing(request: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    result: {},
  };
}

export function makeError(request: JsonRpcRequest, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    error: { code, message },
  };
}

// ---- Tool Dispatch ----

export type ToolHandler = (params: Record<string, unknown>, env: Env) => Promise<McpToolResult>;

export function makeToolResult(text: string, structured?: unknown): McpToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: structured,
  };
}

export function makeToolError(message: string): McpToolResult {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
  };
}
