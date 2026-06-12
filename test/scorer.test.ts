// ============================================================
// Scorer (intent mismatch hard filter) — Unit Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  isHardIntentMismatch,
  cjkSubTokenCoverage,
  hasCJKText,
  processResults,
} from '../src/scorer';

describe('hasCJKText', () => {
  it('detects CJK Unified Ideographs', () => {
    expect(hasCJKText('你好')).toBe(true);
    expect(hasCJKText('transformer 论文')).toBe(true);
  });
  it('returns false for pure ASCII / Latin', () => {
    expect(hasCJKText('hello world')).toBe(false);
    expect(hasCJKText('München')).toBe(false);
  });
});

describe('cjkSubTokenCoverage', () => {
  it('returns 1.0 when query has no 2+ char CJK tokens', () => {
    expect(cjkSubTokenCoverage('foo', 'hello world')).toBe(1);
  });
  it('returns high coverage when all tokens match', () => {
    expect(cjkSubTokenCoverage('你好世界 论文', '你好世界 论文')).toBe(1);
  });
  it('returns low coverage for CJK SEO spam', () => {
    // Query: 禁烟政策 (smoking ban policy). Result: 体育新闻 about NBA.
    const coverage = cjkSubTokenCoverage(
      'NBA总决赛 比分回放 体育资讯',
      '禁烟政策',
    );
    expect(coverage).toBe(0);
  });
  it('returns partial coverage when some tokens match', () => {
    // Query: 禁烟政策. Result: 禁烟 政策公告 (has both tokens, paraphrased).
    const coverage = cjkSubTokenCoverage('禁烟 政策公告', '禁烟政策');
    expect(coverage).toBeGreaterThan(0);
  });
  it('normalises NFKC so fullwidth chars match', () => {
    // "ＡＢＣ" fullwidth should match "abc"
    expect(cjkSubTokenCoverage('ＡＢＣ', 'abc')).toBeGreaterThan(0);
  });
});

describe('isHardIntentMismatch', () => {
  it('drops unrelated CJK SEO spam', () => {
    const r = { title: 'NBA总决赛 比分', snippet: '体育资讯 回放' };
    expect(isHardIntentMismatch(r, '禁烟政策')).toBe(true);
  });
  it('keeps CJK results that share query tokens', () => {
    const r = { title: '禁烟政策解读', snippet: '公共场所禁烟' };
    expect(isHardIntentMismatch(r, '禁烟政策')).toBe(false);
  });
  it('keeps English results that share any 3+-token', () => {
    const r = { title: 'Transformer paper', snippet: 'attention is all you need' };
    expect(isHardIntentMismatch(r, 'transformer attention paper')).toBe(false);
  });
  it('drops English results that miss all tokens on long queries', () => {
    const r = { title: 'Cooking recipes', snippet: 'pasta carbonara' };
    expect(isHardIntentMismatch(r, 'transformer attention is all you need')).toBe(true);
  });
  it('keeps short queries leniently (no hard filter for 1-2 tokens)', () => {
    const r = { title: 'Random article', snippet: 'something else' };
    expect(isHardIntentMismatch(r, 'weather')).toBe(false);
  });
  it('keeps results that contain the full query as a substring', () => {
    const r = { title: 'X', snippet: 'foo' };
    expect(isHardIntentMismatch(r, 'foo')).toBe(false);
  });
  it('returns false for empty query', () => {
    const r = { title: 'X', snippet: 'Y' };
    expect(isHardIntentMismatch(r, '')).toBe(false);
  });
});

describe('processResults — integration with hard filter', () => {
  it('drops hard-mismatch CJK results but keeps the rest', () => {
    const raw = [
      { title: '禁烟政策解读', url: 'https://gov.cn/1', snippet: '公共场所禁烟', source: 'bocha', quality: 'green' as const, score: 0 },
      { title: 'NBA总决赛', url: 'https://sports.com/2', snippet: '体育比分', source: 'duckduckgo', quality: 'green' as const, score: 0 },
    ];
    const out = processResults(raw, '禁烟政策', 5);
    expect(out.map((r) => r.url)).toEqual(['https://gov.cn/1']);
  });
});
