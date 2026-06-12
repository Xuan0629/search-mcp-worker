import type { SearchResult } from '../types';
import { DEFAULT_TIMEOUT_MS } from '../constants';
import { decodeHtmlEntities, stripHtmlTags } from '../utils/html';

// ---- GitHub Repos ----

export async function searchGitHub(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 30)}&sort=stars`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'search-mcp-worker/0.1',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    return (data?.items ?? []).map((repo: any): SearchResult => ({
      title: repo.full_name || repo.name,
      url: repo.html_url,
      snippet: (repo.description || '').slice(0, 300),
      source: 'github',
      publishedDate: repo.updated_at,
      quality: 'green',
      score: 0,
    }));
  } catch {
    return [];
  }
}

// ---- StackExchange ----

export async function searchStackExchange(
  query: string,
  limit: number,
  site = 'stackoverflow',
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=${site}&pagesize=${limit}&filter=withbody`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    return (data?.items ?? []).map((item: any): SearchResult => ({
      title: item.title || '',
      url: item.link,
      snippet: stripHtml(item.body || item.excerpt || '').slice(0, 300),
      source: 'stackexchange',
      quality: 'green',
      score: 0,
    }));
  } catch {
    return [];
  }
}

// ---- npm ----

export async function searchNpm(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    return (data?.objects ?? []).map((obj: any): SearchResult => {
      const pkg = obj.package || {};
      return {
        title: `${pkg.name}@${pkg.version}`,
        url: pkg.links?.npm || `https://www.npmjs.com/package/${pkg.name}`,
        snippet: (pkg.description || '').slice(0, 300),
        source: 'npm',
        quality: 'green',
        score: 0,
      };
    });
  } catch {
    return [];
  }
}

// ---- PyPI ----

export async function searchPyPI(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    // Try JSON API for exact package first
    const url = `https://pypi.org/pypi/${encodeURIComponent(query)}/json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.ok) {
      const data = await response.json() as any;
      const info = data?.info;
      if (info) {
        return [{
          title: `${info.name}@${info.version}`,
          url: info.project_url || `https://pypi.org/project/${info.name}`,
          snippet: (info.summary || info.description || '').slice(0, 300),
          source: 'pypi',
          quality: 'green',
          score: 0,
        }];
      }
    }

    // Fallback: search via HTML scraping
    return searchPyPIHtml(query, limit, timeout);
  } catch {
    return [];
  }
}

async function searchPyPIHtml(
  query: string,
  limit: number,
  timeout: number,
): Promise<SearchResult[]> {
  try {
    const url = `https://pypi.org/search/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'text/html' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const html = await response.text();

    // Parse search result snippets
    const results: SearchResult[] = [];
    const snippetRegex = /class="package-snippet"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = snippetRegex.exec(html)) !== null && results.length < limit) {
      const urlPath = match[1];
      const content = match[2];

      const nameMatch = /class="package-snippet__name">([^<]+)/i.exec(content);
      const descMatch = /class="package-snippet__description">([^<]+)/i.exec(content);

      if (nameMatch) {
        results.push({
          title: nameMatch[1].trim(),
          url: `https://pypi.org${urlPath}`,
          snippet: descMatch ? descMatch[1].trim() : '',
          source: 'pypi',
          quality: 'green',
          score: 0,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ---- crates.io (Rust) ----

export async function searchCrates(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${limit}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'search-mcp-worker/0.1 (search-mcp@example.com)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    return (data?.crates ?? []).map((crate: any): SearchResult => ({
      title: `${crate.name}@${crate.max_stable_version || crate.max_version}`,
      url: `https://crates.io/crates/${crate.name}`,
      snippet: (crate.description || '').slice(0, 300),
      source: 'crates',
      quality: 'green',
      score: 0,
    }));
  } catch {
    return [];
  }
}

// ---- Hacker News ----

export async function searchHackerNews(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    return (data?.hits ?? []).map((hit: any): SearchResult => ({
      title: hit.title || '',
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      snippet: (hit.story_text || hit.comment_text || '').replace(/<[^>]+>/g, '').slice(0, 300),
      source: 'hackernews',
      publishedDate: hit.created_at,
      quality: 'green',
      score: 0,
    }));
  } catch {
    return [];
  }
}

// ---- Helper ----

function stripHtml(html: string): string {
  return stripHtmlTags(decodeHtmlEntities(html)).trim();
}
