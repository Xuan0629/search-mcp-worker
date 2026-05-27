import type { SearchResult } from '../types';
import { USER_AGENTS, DEFAULT_TIMEOUT_MS } from '../constants';

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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
    titles.push({ url: decodeURIComponent(match[1]), title: stripHtml(match[2]) });
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
      links.push({ url: match[1], title: stripHtml(match[2]) });
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
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
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
