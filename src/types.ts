// ============================================================
// search-mcp-worker — Core Type Definitions
// ============================================================

// ---- MCP Protocol Types ----

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  structuredContent?: unknown;
}

// ---- Search Types ----

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;        // engine name that produced this result
  publishedDate?: string;
  siteName?: string;
  summary?: string;       // AI-generated summary (Bocha)
  quality: ResultQuality;
  score: number;
}

export type ResultQuality = 'green' | 'yellow' | 'red' | 'blocked' | 'empty';

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  engines: string[];       // engines that were attempted
  totalResults?: number;
  cached: boolean;
}

export interface EngineConfig {
  name: string;
  displayName: string;
  category: EngineCategory;
  languages: Language[];
  timeout: number;         // ms
  maxResults: number;
  requiresApiKey: boolean;
  apiKeyEnvVar?: string;
}

export type EngineCategory = 'general' | 'chinese' | 'academic' | 'developer' | 'reference' | 'news' | 'tool';
export type Language = 'zh' | 'en' | 'any';
export type Intent = 'general' | 'academic' | 'developer' | 'news' | 'reference';

export interface RouterResult {
  engines: string[];       // ordered list of engine names to try
  intent: Intent;
  language: Language;
  confidence: number;
}

export interface FetchOptions {
  url: string;
  maxChars?: number;
  timeout?: number;
}

export interface CachedResponse {
  data: SearchResponse;
  expiresAt: number;
}

// ---- Cloudflare Worker Env ----

export interface Env {
  BOCHA_API_KEY: string;
  ENVIRONMENT?: string;
}

// ---- Utility ----

export interface LRUCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
  size: number;
}
