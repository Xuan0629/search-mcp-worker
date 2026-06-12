import type { SearchResult } from '../types';
import { USER_AGENTS, DEFAULT_TIMEOUT_MS } from '../constants';
import { decodeHtmlEntities, stripHtmlTags } from '../utils/html';

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Decode a raw URL extracted from DDG HTML.
 *
 * DDG wraps real result URLs inside redirect links like:
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&amp;rut=...
 *
 * This function:
 *  1. Cleans HTML entities (&amp; → &) that DDG embeds in href attributes.
 *  2. Detects the DDG redirect pattern and extracts + decodes the `uddg`
 *     query parameter which contains the actual destination URL.
 *  3. Falls back to plain decodeURIComponent for non-redirect URLs.
 */
function decodeDdgUrl(raw: string): string {
  // Step 1 — clean HTML entities that DDG embeds inside href values
  let url = raw.replace(/&amp;/g, '&');

  // Step 2 — check for DDG redirect URL and extract the real URL from uddg param
  const ddgRedirectMatch = url.match(/duckduckgo\.com\/l\/\?(?:.*&)?uddg=([^&]+)/);
  if (ddgRedirectMatch) {
    try {
      return decodeURIComponent(ddgRedirectMatch[1]);
    } catch {
      // If decoding fails, return the raw uddg value as-is
      return ddgRedirectMatch[1];
    }
  }

  // Step 3 — not a redirect, just decode percent-encoding normally
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function extractResults(html: string, engine: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo result patterns
  // Path 1: result__a links (standard DDG)
  const titleRegex = /class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  const snippetRegex = /class="result__snippet"[^>]*>(.*?)<\/[at]/gi;

  const titles: Array<{url: string; title: string}> = [];
  let match;
  while ((match = titleRegex.exec(html)) !== null) {
    titles.push({ url: decodeDdgUrl(match[1]), title: stripHtml(match[2]) });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1]));
  }

  for (let i = 0; i < titles.length; i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] || '',
      source: engine,
      quality: 'green',
      score: 0,
    });
  }

  // Path 2: fallback — generic link extraction from DDG lite
  if (results.length === 0) {
    const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
    const snippetRegex2 = /<td[^>]+class="result-snippet"[^>]*>(.*?)<\/td>/gi;

    const links: Array<{url: string; title: string}> = [];
    while ((match = linkRegex.exec(html)) !== null) {
      links.push({ url: decodeDdgUrl(match[1]), title: stripHtml(match[2]) });
    }

    const snips2: string[] = [];
    while ((match = snippetRegex2.exec(html)) !== null) {
      snips2.push(stripHtml(match[1]));
    }

    for (let i = 0; i < links.length; i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snips2[i] || '',
        source: engine,
        quality: 'green',
        score: 0,
      });
    }
  }

  return results;
}

function stripHtml(html: string): string {
  return stripHtmlTags(decodeHtmlEntities(html)).trim();
}

// DDG has 3 paths: noai, lite, html
const DDG_PATHS = [
  'https://html.duckduckgo.com/html/?q=',
  'https://lite.duckduckgo.com/lite/?q=',
  'https://duckduckgo.com/html/?q=',
];

export async function searchDuckDuckGo(
  query: string,
  limit: number,
  region = 'us-en',
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query);

  for (const baseUrl of DDG_PATHS) {
    try {
      const url = `${baseUrl}${encodedQuery}&kl=${region}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) continue;

      const html = await response.text();
      const results = extractResults(html, 'duckduckgo');

      if (results.length > 0) {
        return results.slice(0, limit);
      }
    } catch {
      continue; // try next path
    }
  }

  return [];
}
