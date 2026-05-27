import type { SearchResult } from '../types';
import { USER_AGENTS, DEFAULT_TIMEOUT_MS } from '../constants';

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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

// Sogou uses a custom URL encoding for redirect URLs
function decodeSogouUrl(url: string): string {
  if (!url) return '';
  // If already a real URL, return as-is
  if (url.startsWith('http')) return url;
  // Sogou redirect format: /link?url=...
  if (url.startsWith('/link')) {
    try {
      const params = new URLSearchParams(url.split('?')[1]);
      return params.get('url') || url;
    } catch { return url; }
  }
  return url;
}

export async function searchSogou(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}&num=${limit}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const html = await response.text();

    // Detect verification page
    if (html.includes('antispider') || html.includes('验证')) return [];

    return parseSogouHtml(html, limit);
  } catch {
    return [];
  }
}

function parseSogouHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Sogou result blocks: class="vrwrap" or class="rb"
  const blockRegex = /class="(?:vrwrap|rb)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>)?/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < limit) {
    const block = blockMatch[1];

    // Title link
    const titleMatch = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(block);
    if (!titleMatch) continue;

    const rawUrl = titleMatch[1];
    const title = stripHtml(titleMatch[2]);
    const url = decodeSogouUrl(rawUrl);

    // Snippet
    const snippetMatch = /class="(?:str-text-info|space-txt|ft)"[^>]*>(.*?)<\/p>/i.exec(block) ||
                          /class="str_info"[^>]*>(.*?)<\/p>/i.exec(block);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

    if (title && url.startsWith('http')) {
      results.push({
        title,
        url,
        snippet,
        source: 'sogou',
        quality: 'green',
        score: 0,
      });
    }
  }

  return results;
}
