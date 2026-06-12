// ============================================================
// Site Target — Unit Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import { parseSiteTargetQuery, filterBySiteTarget } from '../src/site-target';

describe('parseSiteTargetQuery', () => {
  it('parses "site:example.com hello world"', () => {
    const r = parseSiteTargetQuery('site:example.com hello world');
    expect(r).toEqual({ host: 'example.com', query: 'hello world' });
  });

  it('lowercases the host', () => {
    const r = parseSiteTargetQuery('site:Example.COM query');
    expect(r?.host).toBe('example.com');
  });

  it('returns null when no site: prefix', () => {
    expect(parseSiteTargetQuery('hello world')).toBeNull();
  });

  it('handles leading whitespace', () => {
    const r = parseSiteTargetQuery('   site:gh.com foo bar');
    expect(r).toEqual({ host: 'gh.com', query: 'foo bar' });
  });

  it('rejects site: with no host', () => {
    expect(parseSiteTargetQuery('site: query')).toBeNull();
  });

  it('preserves multi-word query', () => {
    const r = parseSiteTargetQuery('site:arxiv.org transformer attention is all you need');
    expect(r?.query).toBe('transformer attention is all you need');
  });
});

describe('filterBySiteTarget', () => {
  const samples = [
    { url: 'https://github.com/foo/bar', title: 'gh' },
    { url: 'https://api.github.com/repos', title: 'api' },
    { url: 'https://github.com/foo', title: 'sub' }, // (we test the host suffix)
    { url: 'https://www.notgithub.com/x', title: 'wrong' },
    { url: 'https://example.com/y', title: 'other' },
  ];

  it('keeps results on the exact host and its subdomains', () => {
    const out = filterBySiteTarget(samples, 'github.com');
    expect(out.map((r) => r.url)).toEqual([
      'https://github.com/foo/bar',
      'https://api.github.com/repos',
      'https://github.com/foo',
    ]);
  });

  it('drops results on unrelated hosts', () => {
    const out = filterBySiteTarget(samples, 'example.com');
    expect(out.map((r) => r.url)).toEqual([
      'https://example.com/y',
    ]);
  });

  it('returns empty array when nothing matches', () => {
    const out = filterBySiteTarget(samples, 'nope.com');
    expect(out).toEqual([]);
  });

  it('drops results with malformed URLs', () => {
    const bad = [{ url: 'not a url', title: 'x' }, ...samples];
    const out = filterBySiteTarget(bad, 'github.com');
    expect(out.every((r) => r.url.startsWith('http'))).toBe(true);
  });
});
