import type { Env } from '../types';
import {
  MAX_FETCH_BYTES,
  DEFAULT_MAX_CHARS,
  MAX_URL_CHARS,
  DEFAULT_GITHUB_FILE_CHARS,
  MAX_GITHUB_FILE_CHARS,
  FETCH_TIMEOUT_MS,
} from '../constants';
import { htmlToBodyText } from '../utils/html';

// ---- fetch_url ----

/** Result of a fetchUrl call. The contentType field tells the caller
 * whether we got a real page ('html' / 'json' / 'xml') or a
 * challenge/anti-bot page ('challenge_page') that we couldn't get past.
 * The old code threw on every 4xx, which made the OpenClaw pipeline
 * show "unknown error" to users when the actual issue was just an
 * anti-bot probe. With this shape, the tool can return a useful
 * message ("page blocked by anti-bot") and the caller can decide
 * whether to surface that or to fall back to another source.
 */
export interface FetchResult {
  title: string;
  content: string;
  url: string;
  status: number;
  contentType: 'html' | 'json' | 'xml' | 'plain' | 'challenge_page';
  /** Why the response was classified as a challenge page. Null on success. */
  reason?: string;
}

/** Browser-style User-Agent used for the retry. The first attempt uses
 * a polite worker UA (the original behavior); the second attempt uses
 * a desktop Chrome UA + zh-CN Accept-Language because most anti-bot
 * systems whitelist browser user agents but flag custom worker UAs. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Signatures that anti-bot challenges (Cloudflare, hCaptcha, Google
 * reCAPTCHA, etc.) leave in the response body or status code. We
 * match on the union of these so that a single regex covers the
 * most common upstream patterns.
 *
 * Borrowed heuristic from Kerry1020/search-mcp-worker (re-derived; see
 * site-target.ts for license notes).
 */
const CHALLENGE_SIGNALS = /probe\.js|g_captcha|cf-challenge|challenge-form|__cf_bm|challenge-platform/i;

/** Classify a (body, status) pair. Returns true if the response is
 * almost certainly an anti-bot challenge page rather than real content. */
export function isChallengeResponse(body: string, status: number): boolean {
  if (CHALLENGE_SIGNALS.test(body)) return true;
  // 202 with empty/short body is the classic Cloudflare "JS challenge"
  // pattern: the request was accepted for processing but the worker
  // has to do an interstitial first. Threshold of 100 chars is enough
  // to catch the "Accepted" / blank / single-line cookie-bait bodies
  // while letting through any real HTML (which is rarely < 100 chars).
  if (status === 202 && body.trim().length < 100) return true;
  return false;
}

/** Run a single fetch with a chosen User-Agent + Accept-Language pair. */
async function fetchOnce(
  url: string,
  userAgent: string,
  acceptLanguage: string,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        'Accept-Language': acceptLanguage,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Build a challenge_page result so the caller can decide what to do. */
function challengeResult(
  url: string,
  status: number,
  body: string,
  reason: string,
): FetchResult {
  return {
    title: url,
    content: body.slice(0, Math.min(body.length, DEFAULT_MAX_CHARS)),
    url,
    status,
    contentType: 'challenge_page',
    reason,
  };
}

/** Map a Content-Type header to our coarse-grained contentType enum. */
function classifyContentType(ct: string | null | undefined): FetchResult['contentType'] {
  if (!ct) return 'plain';
  const lower = ct.toLowerCase();
  if (lower.includes('text/html') || lower.includes('application/xhtml')) return 'html';
  if (lower.includes('application/json') || lower.includes('+json')) return 'json';
  if (lower.includes('xml') || lower.includes('+xml')) return 'xml';
  if (lower.includes('text/')) return 'plain';
  return 'plain';
}

export async function fetchUrl(
  url: string,
  maxChars = DEFAULT_MAX_CHARS,
  timeout = FETCH_TIMEOUT_MS,
): Promise<FetchResult> {
  // First attempt: polite worker UA (the previous behavior). If the
  // upstream blocks us, we'll know it's anti-bot rather than a broken
  // server because the status will be 403/202 (not 5xx).
  let response: Response;
  try {
    response = await fetchOnce(
      url,
      'Mozilla/5.0 (compatible; search-mcp-worker/0.1)',
      'en-US,en;q=0.9',
      timeout,
    );
  } catch (err) {
    // Real network error — propagate to the caller.
    throw err;
  }

  // 4xx (other than 404) is a strong anti-bot signal. Retry once with
  // a browser UA + zh-CN Accept-Language before giving up. We
  // intentionally do NOT retry 404 or 5xx — those are real "not found"
  // / "server error" cases, not anti-bot.
  const status = response.status;
  const shouldRetry = status === 403 || status === 202;

  if (shouldRetry) {
    try {
      const retry = await fetchOnce(url, BROWSER_USER_AGENT, 'zh-CN,zh;q=0.9,en;q=0.8', timeout);
      if (retry.ok) {
        response = retry;
      } else {
        // Still blocked. Return a challenge_page result instead of
        // throwing — this is the whole point of the refactor.
        const body = await retry.text().catch(() => '');
        return challengeResult(
          url,
          retry.status,
          body,
          `upstream ${retry.status} after retry — likely anti-bot / data-center IP blocked`,
        );
      }
    } catch {
      // Retry itself failed (network error, etc.). Fall through to
      // return a challenge_page result rather than re-throw.
      return challengeResult(
        url,
        status,
        '',
        `upstream ${status} on first attempt, retry also failed`,
      );
    }
  }

  // Now we have a usable response. Check the body for challenge signals
  // (200 OK is not a guarantee of real content — Cloudflare sometimes
  // returns 200 with a JS challenge page embedded).
  if (!response.ok) {
    // Not an anti-bot status we retry on (404, 410, 500, etc.) — throw
    // so the caller knows the page genuinely doesn't exist / is broken.
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // Enforce byte cap to avoid blowing the workerd memory limit on
  // pathologically large pages.
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (text.length > MAX_FETCH_BYTES) {
    throw new Error(`response too large: ${text.length} bytes (max ${MAX_FETCH_BYTES})`);
  }

  if (isChallengeResponse(text, response.status)) {
    return challengeResult(
      url,
      response.status,
      text,
      response.status === 202
        ? 'HTTP 202 with empty body — likely anti-bot probe'
        : 'JS challenge / anti-bot probe detected in response body',
    );
  }

  const classified = classifyContentType(contentType);
  if (classified === 'plain' && !contentType) {
    // No content-type header at all — treat as challenge rather than
    // trying to parse it as HTML.
    return challengeResult(
      url,
      response.status,
      text,
      'no content-type header — refusing to guess',
    );
  }

  // Extract title (HTML only)
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  const title = titleMatch ? titleMatch[1].trim() : url;

  // Strip HTML tags for text content
  const content = htmlToBodyText(text, Math.min(maxChars, MAX_URL_CHARS));

  return {
    title,
    content,
    url,
    status: response.status,
    contentType: classified,
  };
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
//
// HTML stripping/tag-decoding helpers live in src/utils/html.ts and
// are shared across all 6 HTML-scraping engines + the fetchUrl tool
// (see test/html-utils.test.ts for the per-function contract).
