import type { Env } from '../types';
import {
  MAX_FETCH_BYTES,
  DEFAULT_MAX_CHARS,
  MAX_URL_CHARS,
  DEFAULT_GITHUB_FILE_CHARS,
  MAX_GITHUB_FILE_CHARS,
  FETCH_TIMEOUT_MS,
} from '../constants';

// ---- fetch_url ----

export async function fetchUrl(
  url: string,
  maxChars = DEFAULT_MAX_CHARS,
  timeout = FETCH_TIMEOUT_MS,
): Promise<{ title: string; content: string; url: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; search-mcp-worker/0.1)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('json') && !contentType.includes('xml')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const text = await response.text();

    // Extract title
    const titleMatch = /<title[^>]*>(.*?)<\/title>/i.exec(text);
    const title = titleMatch ? titleMatch[1].trim() : url;

    // Strip HTML tags for text content
    const content = stripToPlainText(text, Math.min(maxChars, MAX_URL_CHARS));

    return { title, content, url };
  } finally {
    clearTimeout(timer);
  }
}

// ---- fetch_github_file ----

export async function fetchGitHubFile(
  owner: string,
  repo: string,
  path: string,
  ref = 'main',
  maxChars = DEFAULT_GITHUB_FILE_CHARS,
  timeout = FETCH_TIMEOUT_MS,
): Promise<{ content: string; path: string; url: string; size: number }> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: { 'Accept': '*/*' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`GitHub raw file error: ${response.status}`);
    }

    const text = await response.text();
    const truncated = text.slice(0, Math.min(maxChars, MAX_GITHUB_FILE_CHARS));

    return {
      content: truncated,
      path,
      url: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`,
      size: text.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- find_rss ----

export async function findRss(
  url: string,
  timeout = FETCH_TIMEOUT_MS,
): Promise<Array<{ title: string; url: string; type: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; search-mcp-worker/0.1)',
        'Accept': 'text/html',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const html = await response.text();

    const feeds: Array<{ title: string; url: string; type: string }> = [];

    // RSS/Atom link patterns
    const rssPatterns = [
      /<link[^>]+type="application\/rss\+xml"[^>]+href="([^"]+)"[^>]+title="([^"]*)"[^>]*>/gi,
      /<link[^>]+type="application\/rss\+xml"[^>]+title="([^"]*)"[^>]+href="([^"]+)"[^>]*>/gi,
      /<link[^>]+type="application\/atom\+xml"[^>]+href="([^"]+)"[^>]+title="([^"]*)"[^>]*>/gi,
      /<link[^>]+type="application\/atom\+xml"[^>]+title="([^"]*)"[^>]+href="([^"]+)"[^>]*>/gi,
    ];

    const seen = new Set<string>();
    for (const pattern of rssPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const feedUrl = match[1] || match[2];
        const feedTitle = match[2] || match[1] || '';
        if (feedUrl && !seen.has(feedUrl)) {
          seen.add(feedUrl);
          // Resolve relative URLs
          const resolvedUrl = feedUrl.startsWith('http')
            ? feedUrl
            : new URL(feedUrl, url).toString();
          feeds.push({
            title: feedTitle || 'RSS Feed',
            url: resolvedUrl,
            type: pattern.source.includes('atom') ? 'atom' : 'rss',
          });
        }
      }
    }

    // Fallback: look for common RSS paths
    if (feeds.length === 0) {
      const commonPaths = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml'];
      for (const path of commonPaths) {
        try {
          const feedUrl = new URL(path, url).toString();
          const feedResp = await fetch(feedUrl, {
            method: 'HEAD',
            headers: { 'User-Agent': 'search-mcp-worker/0.1' },
            signal: AbortSignal.timeout(3000),
          });
          if (feedResp.ok) {
            const ct = feedResp.headers.get('content-type') || '';
            if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom')) {
              feeds.push({
                title: 'RSS Feed',
                url: feedUrl,
                type: ct.includes('atom') ? 'atom' : 'rss',
              });
            }
          }
        } catch { continue; }
      }
    }

    return feeds;
  } catch {
    return [];
  }
}

// ---- Helpers ----

function stripToPlainText(html: string, maxChars: number): string {
  // Remove script and style blocks entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');

  // Strip remaining tags
  text = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, maxChars);
}
