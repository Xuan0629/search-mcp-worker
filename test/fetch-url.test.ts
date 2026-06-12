// ============================================================
// fetchUrl — Unit Tests (challenge page detection + retry)
// ============================================================
//
// fetchUrl's contract expanded in this change: instead of throwing
// on 403/202 (which used to be a frequent 0-info failure for the
// OpenClaw pipeline when fetching Medium/知乎 etc.), it should:
//   1. Detect challenge-page signatures in the response HTML and
//      return a structured 'challenge_page' result with a reason.
//   2. Retry once with a browser-style User-Agent + Accept-Language
//      header on 403/202, to give the upstream a second chance to
//      serve real content.
//   3. Only throw on truly broken responses (network errors, etc.).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchUrl, isChallengeResponse, type FetchResult } from '../src/engines/fetch';

// Mock global fetch so we don't hit the real network.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(opts: {
  status: number;
  body: string;
  contentType?: string;
}): Response {
  return new Response(opts.body, {
    status: opts.status,
    headers: { 'content-type': opts.contentType ?? 'text/html; charset=utf-8' },
  });
}

describe('isChallengeResponse (pure function)', () => {
  it('detects Cloudflare challenge markers', () => {
    expect(isChallengeResponse('<html>cf-challenge-form here</html>', 200)).toBe(true);
    expect(isChallengeResponse('<script src="challenge-platform.js"></script>', 200)).toBe(true);
    expect(isChallengeResponse('Has __cf_bm cookie hint', 200)).toBe(true);
    expect(isChallengeResponse('probe.js running', 200)).toBe(true);
  });

  it('detects Google CAPTCHA markers', () => {
    expect(isChallengeResponse('<div class="g_captcha">', 200)).toBe(true);
  });

  it('does not flag normal HTML pages', () => {
    expect(isChallengeResponse('<html><body>Hello world</body></html>', 200)).toBe(false);
    expect(isChallengeResponse('<article>Some article text</article>', 200)).toBe(false);
  });

  it('flags 202 with empty body as a challenge (CF anti-bot pattern)', () => {
    expect(isChallengeResponse('', 202)).toBe(true);
  });

  it('does not flag 202 with substantial body', async () => {
    // 202 is unusual for HTML but should not be auto-flagged if the
    // body has real content (the caller's responsibility to interpret).
    const substantial = '<html><body><h1>Real page</h1><p>' + 'x'.repeat(200) + '</p></body></html>';
    expect(isChallengeResponse(substantial, 202)).toBe(false);
  });
});

describe('fetchUrl happy path', () => {
  it('returns title and content for a normal 200 response', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockResponse({ status: 200, body: '<html><head><title>Hello</title></head><body>World</body></html>' }),
    );
    const r = await fetchUrl('https://example.com/');
    expect(r.status).toBe(200);
    expect(r.title).toBe('Hello');
    expect(r.content).toContain('World');
    expect(r.contentType).toBe('html');
  });

  it('preserves the original URL even after redirects', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockResponse({ status: 200, body: '<title>Page</title><p>ok</p>' }),
    );
    const r = await fetchUrl('https://example.com/original');
    expect(r.url).toBe('https://example.com/original');
  });
});

describe('fetchUrl challenge detection (single fetch, no retry needed)', () => {
  it('returns a challenge_page result when the body contains cf-challenge-form', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockResponse({
        status: 200,
        body: '<html><body>cf-challenge-form running...</body></html>',
      }),
    );
    const r = await fetchUrl('https://challenge-site.example/');
    expect(r.contentType).toBe('challenge_page');
    expect(r.reason).toMatch(/JS challenge|anti-bot/i);
    // Challenge pages should still include the body so the caller
    // can decide what to do (e.g. notify the user that the page
    // was blocked by anti-bot rather than treating it as 'empty').
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('returns a challenge_page result for HTTP 202 with empty body', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockResponse({ status: 202, body: '' }),
    );
    const r = await fetchUrl('https://anti-bot.example/');
    expect(r.contentType).toBe('challenge_page');
    expect(r.reason).toMatch(/202|anti-bot/i);
  });
});

describe('fetchUrl retry path (browser UA second attempt)', () => {
  it('retries with Chrome desktop UA on first 403, succeeds second time', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse({ status: 403, body: 'Forbidden' }))
      .mockResolvedValueOnce(
        mockResponse({ status: 200, body: '<title>After retry</title><p>ok</p>' }),
      );
    const r = await fetchUrl('https://medium.com/@someone/post');
    // Second fetch succeeded, so we return the real content.
    expect(r.status).toBe(200);
    expect(r.title).toBe('After retry');
    expect(r.content).toContain('ok');
    // Confirm we actually fired two requests.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // The first request used the default UA, the second used a
    // browser UA — confirm by inspecting the calls.
    const calls = (globalThis.fetch as any).mock.calls as Array<[string, RequestInit]>;
    const firstHeaders = (calls[0][1].headers as Record<string, string>);
    const secondHeaders = (calls[1][1].headers as Record<string, string>);
    expect(firstHeaders['User-Agent']).toContain('search-mcp-worker');
    expect(secondHeaders['User-Agent']).toContain('Mozilla');
  });

  it('returns challenge_page if both attempts are blocked', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse({ status: 403, body: 'Forbidden' }))
      .mockResolvedValueOnce(mockResponse({ status: 403, body: 'Still forbidden' }));
    const r = await fetchUrl('https://heavily-protected.example/');
    expect(r.status).toBe(403);
    expect(r.contentType).toBe('challenge_page');
    expect(r.reason).toMatch(/anti-bot|403|challenge/i);
  });

  it('only retries once (does not loop on persistent blocks)', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse({ status: 403, body: '' }))
      .mockResolvedValueOnce(mockResponse({ status: 403, body: '' }));
    await fetchUrl('https://locked.example/');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('fetchUrl real errors (not challenges)', () => {
  it('throws on network error (fetch rejects)', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(new TypeError('Network unreachable'));
    await expect(fetchUrl('https://offline.example/')).rejects.toThrow(/Network unreachable/);
  });

  it('throws on 500 server error (not anti-bot)', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      mockResponse({ status: 500, body: 'Internal Server Error' }),
    );
    await expect(fetchUrl('https://broken.example/')).rejects.toThrow(/500/);
  });
});
