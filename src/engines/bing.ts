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

function parseBingResults(html: string, engine: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Bing uses class="b_algo" for organic results
  const blockRegex = /class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const block = blockMatch[1];

    // Extract title and URL
    const titleMatch = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(block);
    if (!titleMatch) continue;

    let url = titleMatch[1];
    const title = stripHtml(titleMatch[2]);

    // Handle Bing's base64 encoded redirect URLs
    if (url.startsWith('/u/a1')) {
      try {
        const encoded = url.replace(/^\/u\/a1\?/, '');
        const params = new URLSearchParams(encoded);
        const u = params.get('u');
        if (u) {
          // Bing uses a custom base64 variant: replace - with +, _ with /
          const decoded = atob(u.replace(/-/g, '+').replace(/_/g, '/'));
          // Extract actual URL from decoded string
          const urlMatch = decoded.match(/https?:\/\/[^\x00-\x1f]+/);
          if (urlMatch) url = urlMatch[0];
        }
      } catch {
        // Keep original URL if decoding fails
      }
    }

    // Extract snippet
    const snippetMatch = /class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(block) ||
                          /<p[^>]*>(.*?)<\/p>/i.exec(block);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

    if (title && url && !url.startsWith('/')) {
      results.push({
        title,
        url,
        snippet,
        source: engine,
        quality: 'green',
        score: 0,
      });
    }
  }

  return results;
}

export async function searchBing(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  return searchBingBase('https://www.bing.com/search', query, limit, 'en-US', timeout, 'bing');
}

export async function searchBingCN(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  return searchBingBase('https://cn.bing.com/search', query, limit, 'zh-CN', timeout, 'bing_cn');
}

async function searchBingBase(
  baseUrl: string,
  query: string,
  limit: number,
  language: string,
  timeout: number,
  engine: string,
): Promise<SearchResult[]> {
  try {
    const url = `${baseUrl}?q=${encodeURIComponent(query)}&setlang=${language}&cc=${language === 'zh-CN' ? 'cn' : 'us'}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': `${language},*;q=0.5`,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];

    const html = await response.text();

    // Detect CAPTCHA/verification page
    if (html.includes('Verification') || html.includes('bnp_cookie_verify')) {
      return [];
    }

    return parseBingResults(html, engine).slice(0, limit);
  } catch {
    return [];
  }
}
