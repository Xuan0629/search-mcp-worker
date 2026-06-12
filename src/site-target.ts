// ============================================================
// search-mcp-worker — `site:example.com` operator
// ============================================================
//
// Parses the `site:host query` prefix and returns the target host + the
// remainder of the query, or null if no operator is present.
//
// Pattern borrowed from Kerry1020/search-mcp-worker (re-derived; we re-implement
// the idea rather than copy code because the original is GPL-3.0 and our
// project is MIT).

import { SITE_TARGET_PATTERN } from './constants';

export interface SiteTarget {
  host: string;
  query: string;
}

export function parseSiteTargetQuery(input: string): SiteTarget | null {
  const match = input.match(SITE_TARGET_PATTERN);
  if (!match) return null;
  return {
    host: match[1].toLowerCase(),
    query: match[2].trim(),
  };
}

/** Keep only results whose URL host matches (or is a subdomain of) targetHost. */
export function filterBySiteTarget<T extends { url: string }>(
  results: T[],
  targetHost: string,
): T[] {
  const t = targetHost.toLowerCase();
  return results.filter((r) => {
    try {
      const host = new URL(r.url).hostname.toLowerCase();
      return host === t || host.endsWith(`.${t}`);
    } catch {
      return false;
    }
  });
}
