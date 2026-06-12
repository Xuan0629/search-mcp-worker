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
  CJK_INTENT_COVERAGE_MIN,
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

// ---- Hard Intent Mismatch Filter ----

/**
 * True if `text` contains at least one CJK character.
 * Used to gate the CJK-specific intent filter.
 */
export function hasCJKText(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * NFKC-normalised compact comparison. Treats fullwidth / halfwidth variants
 * (e.g. "ＡＢＣ" vs "abc") as identical. Mirrors the trick used in
 * Kerry1020/search-mcp-worker to reduce false negatives in CJK matching.
 */
function normalizeCompact(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/**
 * CJK sub-token coverage: fraction of unique 2-character CJK substrings of
 * the query that appear anywhere in the result text. A result with coverage
 * below CJK_INTENT_COVERAGE_MIN (when the query contains ≥1 2-char token) is
 * almost certainly off-topic for a Chinese query.
 *
 * Borrowed heuristic from Kerry1020/search-mcp-worker (re-derived; the
 * original is GPL-3.0 and our project is MIT).
 */
export function cjkSubTokenCoverage(text: string, query: string): number {
  const queryTokens = tokenize(query).filter((t) => /[\u4e00-\u9fff]/.test(t) && t.length >= 2);
  if (queryTokens.length === 0) return 1; // not a CJK query; vacuously satisfied

  const compactText = normalizeCompact(text);
  let hit = 0;
  const seen = new Set<string>();
  for (const token of queryTokens) {
    // Deduplicate repeated tokens to avoid weighting "model 模型 模型" 3x.
    if (seen.has(token)) continue;
    seen.add(token);
    if (compactText.includes(normalizeCompact(token))) hit++;
  }
  return hit / queryTokens.length;
}

/**
 * Hard intent-mismatch decision for a single result.
 *
 * - Non-CJK queries: a result is a mismatch only if it scores zero token hits
 *   with a 3+-token query (matches the existing SCORE_INTENT_MISMATCH_PENALTY
 *   rule, but applied as a hard filter rather than just a penalty).
 * - CJK queries: a result is a mismatch if (a) the full query (NFKC-compact)
 *   doesn't appear in the text AND (b) no 2+-char CJK token from the query
 *   appears in the text AND (c) sub-token coverage is below the threshold.
 *
 * The intent is to drop Chinese SEO spam that shares zero vocabulary with
 * the query while keeping legitimate results that paraphrase the query.
 */
export function isHardIntentMismatch(
  result: { title: string; snippet: string },
  query: string,
): boolean {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return false;

  const title = result.title || '';
  const snippet = result.snippet || '';
  const combined = `${title} ${snippet}`;

  if (hasCJKText(query)) {
    // CJK path: NFKC + compact comparison.
    const compactText = normalizeCompact(combined);
    const compactQuery = normalizeCompact(query);
    if (compactQuery && compactText.includes(compactQuery)) return false;

    // Try per-token match for any 2+ char CJK token.
    const cjkTokens = queryTokens.filter((t) => /[\u4e00-\u9fff]/.test(t) && t.length >= 2);
    const tokenMatch = cjkTokens.some((t) => compactText.includes(normalizeCompact(t)));
    if (tokenMatch) return false;

    // Fall back to sub-token coverage.
    if (cjkSubTokenCoverage(combined, query) >= CJK_INTENT_COVERAGE_MIN) return false;

    return true;
  }

  // Non-CJK path: only flag if query is long enough that 0 hits is meaningful.
  if (queryTokens.length < 3) return false;
  const lower = combined.toLowerCase();
  return !queryTokens.some((t) => lower.includes(t.toLowerCase()));
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
  // Hard intent-mismatch filter: drop CJK SEO spam that shares zero
  // vocabulary with the query, and English results that miss 100% of
  // tokens on long queries.
  const filtered = evaluated.filter((r) => !isHardIntentMismatch(r, query));
  const scored = scoreResults(filtered, query);
  return rankResults(scored, maxResults);
}
