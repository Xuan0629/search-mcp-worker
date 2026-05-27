import type { SearchResult, ResultQuality, Intent } from './types';
import {
  SCORE_QUALITY_GREEN,
  SCORE_QUALITY_YELLOW,
  SCORE_RANK_BASE,
  SCORE_RANK_DECAY,
  SCORE_MULTI_SOURCE_BONUS,
  SCORE_TOKEN_MATCH_BONUS,
  SCORE_OFFICIAL_DOMAIN_BONUS,
  SCORE_GENERIC_WRAPPER_PENALTY,
  SCORE_INTENT_MISMATCH_PENALTY,
  SCORE_LOW_TRUST_PENALTY,
  OFFICIAL_DOMAINS,
  LOW_TRUST_TLDS,
  LOW_TRUST_SUBDOMAIN_PATTERNS,
} from './constants';

// ---- Quality Evaluation ----

const GENERIC_WRAPPER_PATTERNS = [
  /search\s*(results?|page|web)/i,
  /related\s*searches/i,
  /people\s*also\s*ask/i,
  /featured\s*snippet/i,
  /^$/,  // empty title
];

const JUNK_URL_PATTERNS = [
  /\/search\?/, /\/search\/?$/, /\/s\?/,
  /\?q=/, /\?query=/, /\?keyword=/,
  /\/login/, /\/signup/, /\/register/,
  /\/cart/, /\/checkout/,
];

export function evaluateQuality(result: { title: string; url: string; snippet: string }): ResultQuality {
  const { title, url, snippet } = result;

  // Empty result
  if (!title && !snippet) return 'empty';
  if (!url) return 'empty';

  // Generic wrapper detection
  for (const pattern of GENERIC_WRAPPER_PATTERNS) {
    if (pattern.test(title)) return 'blocked';
  }

  // Junk URL detection
  for (const pattern of JUNK_URL_PATTERNS) {
    if (pattern.test(url)) return 'blocked';
  }

  // Low-trust domain detection
  if (isLowTrust(url)) return 'red';

  // Very short or suspicious snippets
  if (snippet.length < 20 && title.length < 10) return 'yellow';

  return 'green';
}

function isLowTrust(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Check suspicious TLDs
    for (const tld of LOW_TRUST_TLDS) {
      if (hostname.endsWith(tld)) return true;
    }
    // Check suspicious subdomain patterns
    for (const pattern of LOW_TRUST_SUBDOMAIN_PATTERNS) {
      const parts = hostname.split('.');
      if (parts.length > 2 && pattern.test(parts[0])) return true;
    }
  } catch {
    return true; // malformed URL
  }
  return false;
}

// ---- Intent Match Scoring ----

export function computeIntentMatch(title: string, snippet: string, queryTokens: string[]): number {
  const text = (title + ' ' + snippet).toLowerCase();
  let matches = 0;
  for (const token of queryTokens) {
    if (text.includes(token.toLowerCase())) matches++;
  }
  return matches;
}

function tokenize(query: string): string[] {
  // Split on whitespace and common delimiters, filter short tokens
  return query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

// ---- Deduplication ----

export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();

  for (const result of results) {
    const normalizedUrl = normalizeUrl(result.url);
    const existing = seen.get(normalizedUrl);

    if (existing) {
      // Merge: add source attribution, keep higher quality
      if (!existing.source.includes(result.source)) {
        existing.source = `${existing.source},${result.source}`;
      }
      // Keep result with better snippet
      if (result.snippet.length > existing.snippet.length) {
        existing.snippet = result.snippet;
        existing.title = result.title;
      }
      if (result.summary && !existing.summary) {
        existing.summary = result.summary;
      }
    } else {
      seen.set(normalizedUrl, { ...result, url: normalizedUrl });
    }
  }

  return Array.from(seen.values());
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove trailing slash, common tracking params, and fragments
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('ref');
    u.searchParams.delete('src');
    let normalized = u.toString();
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return normalized;
  } catch {
    return url;
  }
}

// ---- Scoring ----

export function scoreResults(results: SearchResult[], query: string): SearchResult[] {
  const queryTokens = tokenize(query);
  const isOfficialDomain = (url: string) => {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return OFFICIAL_DOMAINS.some(d => hostname.endsWith(d) || hostname === d);
    } catch { return false; }
  };

  return results.map((result, index) => {
    let score = 0;

    // Quality score
    if (result.quality === 'green') score += SCORE_QUALITY_GREEN;
    else if (result.quality === 'yellow') score += SCORE_QUALITY_YELLOW;
    else if (result.quality === 'red') score += 0;
    else score += 0; // blocked/empty

    // Rank within engine
    const rank = Math.max(0, SCORE_RANK_BASE - index * SCORE_RANK_DECAY);
    score += rank;

    // Multi-source bonus
    const sourceCount = result.source.split(',').length;
    score += (sourceCount - 1) * SCORE_MULTI_SOURCE_BONUS;

    // Token match bonus
    const matches = computeIntentMatch(result.title, result.snippet, queryTokens);
    score += matches * SCORE_TOKEN_MATCH_BONUS;

    // Official domain bonus
    if (isOfficialDomain(result.url)) score += SCORE_OFFICIAL_DOMAIN_BONUS;

    // Penalties
    if (result.quality === 'blocked') score += SCORE_GENERIC_WRAPPER_PENALTY;
    if (matches === 0 && queryTokens.length > 2) score += SCORE_INTENT_MISMATCH_PENALTY;
    if (result.quality === 'red') score += SCORE_LOW_TRUST_PENALTY;

    return { ...result, score };
  });
}

// ---- Ranking ----

export function rankResults(results: SearchResult[], maxResults: number): SearchResult[] {
  return results
    .filter(r => r.quality !== 'blocked' && r.quality !== 'empty')
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// ---- Full Pipeline ----

export function processResults(
  rawResults: SearchResult[],
  query: string,
  maxResults: number,
): SearchResult[] {
  const deduped = deduplicateResults(rawResults);
  // Evaluate quality for results that don't have it yet
  const evaluated = deduped.map(r => ({
    ...r,
    quality: r.quality ?? evaluateQuality(r),
  }));
  const scored = scoreResults(evaluated, query);
  return rankResults(scored, maxResults);
}
