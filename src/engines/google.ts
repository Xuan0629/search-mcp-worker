import type { SearchResult } from '../types';
import { DEFAULT_TIMEOUT_MS } from '../constants';
import { decodeHtmlEntities, stripHtmlTags } from '../utils/html';
import { randomUserAgent } from '../utils/http';

function stripHtml(html: string): string {
  return stripHtmlTags(decodeHtmlEntities(html)).trim();
}

/**
 * Google search — MINIMAL PLACEHOLDER.
 * Google aggressively blocks scraping with CAPTCHA.
 * This is a best-effort implementation; expect empty results frequently.
 * Use DuckDuckGo/Bing/Bocha as reliable alternatives.
 */
export async function searchGoogle(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&hl=en`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const html = await response.text();

    // Detect CAPTCHA/consent/bot detection
    if (
      html.includes('captcha') ||
      html.includes('CAPTCHA') ||
      html.includes('sorry/index') ||
      html.includes('unusual traffic') ||
      html.includes('detected unusual traffic') ||
      html.length < 5000 // probably a redirect/block page
    ) {
      return [];
    }

    return parseGoogleHtml(html, limit);
  } catch {
    return [];
  }
}

function parseGoogleHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Google result divs: data-attrid="action/api" or class="g" with data-hveid
  // Try multiple patterns since Google frequently changes their HTML structure

  // Pattern 1: class="g" blocks
  const blockRegex = /<div[^>]+class="g"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < limit) {
    const block = blockMatch[1];

    // Title
    const titleMatch = /<h3[^>]*>(.*?)<\/h3>/i.exec(block);
    if (!titleMatch) continue;
    const title = stripHtml(titleMatch[1]);

    // URL — look for the first <a> with href starting with http
    const urlMatch = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/i.exec(block);
    if (!urlMatch) continue;
    const url = urlMatch[1];

    // Skip Google internal URLs
    if (url.includes('google.com') || url.includes('googleusercontent.com')) continue;

    // Snippet
    const snippetMatch = /<span[^>]*>([\s\S]*?)<\/span>/i.exec(block);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).slice(0, 300) : '';

    results.push({
      title,
      url,
      snippet,
      source: 'google',
      quality: 'green',
      score: 0,
    });
  }

  return results;
}
