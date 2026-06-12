import type { SearchResult } from '../types';
import { DEFAULT_TIMEOUT_MS } from '../constants';
import { decodeHtmlEntities, stripHtmlTags } from '../utils/html';
import { randomUserAgent } from '../utils/http';

function stripHtml(html: string): string {
  return stripHtmlTags(decodeHtmlEntities(html)).trim();
}

export async function searchBaidu(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  // Strategy: try JSON API first (more reliable), then HTML fallback
  const results = await tryBaiduJson(query, limit, timeout);
  if (results.length > 0) return results;

  return tryBaiduHtml(query, limit, timeout);
}

async function tryBaiduJson(
  query: string,
  limit: number,
  timeout: number,
): Promise<SearchResult[]> {
  try {
    const url = `https://m.baidu.com/s?word=${encodeURIComponent(query)}&pn=0&rn=${limit}&tn=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];

    const data = await response.json() as any;

    // Baidu JSON format: feed.entry array
    const entries = data?.feed?.entry ?? [];
    return entries.slice(0, limit).map((entry: any): SearchResult => ({
      title: entry.title || '',
      url: entry.url || '',
      snippet: stripHtml(entry.abs || ''),
      source: 'baidu',
      quality: 'green',
      score: 0,
    }));
  } catch {
    return [];
  }
}

async function tryBaiduHtml(
  query: string,
  limit: number,
  timeout: number,
): Promise<SearchResult[]> {
  try {
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${limit}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const html = await response.text();

    // Detect verification page
    if (html.includes('verify') || html.includes('baidu.com/verify')) return [];

    return parseBaiduHtml(html, limit);
  } catch {
    return [];
  }
}

function parseBaiduHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Baidu result blocks: class="c-container" or class="result"
  const blockRegex = /class="(?:c-container|result)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < limit) {
    const block = blockMatch[1];

    // Title link
    const titleMatch = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(block);
    if (!titleMatch) continue;

    const url = titleMatch[1];
    const title = stripHtml(titleMatch[2]);

    // Snippet
    const snippetPatterns = [
      /class="c-abstract"[^>]*>(.*?)<\/(?:span|div)>/i,
      /class="content-right_[^"]*"[^>]*>(.*?)<\/span>/i,
      /<span[^>]+class="[^"]*content[^"]*"[^>]*>(.*?)<\/span>/i,
    ];

    let snippet = '';
    for (const pattern of snippetPatterns) {
      const m = pattern.exec(block);
      if (m) { snippet = stripHtml(m[1]); break; }
    }

    if (title && url && !url.startsWith('/')) {
      results.push({
        title,
        url,
        snippet,
        source: 'baidu',
        quality: 'green',
        score: 0,
      });
    }
  }

  return results;
}
