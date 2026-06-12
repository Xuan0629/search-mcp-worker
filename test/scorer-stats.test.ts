// ============================================================
// Scorer — Unit Tests (processResultsWithStats / _meta pipeline)
// ============================================================

import { describe, it, expect } from 'vitest';
import { processResultsWithStats } from '../src/scorer';
import type { SearchResult } from '../src/types';

const baseResult = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  title: 'X',
  url: 'https://example.com/x',
  snippet: 'snip',
  source: 'engine',
  quality: 'green',
  score: 0,
  ...overrides,
});

describe('processResultsWithStats', () => {
  it('returns zero filtered_count when nothing was dropped', () => {
    const raw = [
      baseResult({ title: 'foo bar', snippet: 'foo bar', url: 'https://a.com/1' }),
      baseResult({ title: 'foo bar', snippet: 'foo bar', url: 'https://b.com/2' }),
    ];
    const { results, stats } = processResultsWithStats(raw, 'foo bar', 5);
    expect(results.length).toBe(2);
    expect(stats.filtered_count).toBe(0);
    expect(stats.filter_reason).toBe(null);
  });

  it('counts dropped CJK results and reports intent_mismatch', () => {
    const raw = [
      baseResult({ title: '禁烟政策', snippet: '公共场所禁烟', url: 'https://gov.cn/1' }),
      baseResult({ title: 'NBA总决赛', snippet: '体育比分', url: 'https://sports.com/2' }),
      baseResult({ title: '英超赛程', snippet: '足球比分', url: 'https://soccer.com/3' }),
    ];
    const { results, stats } = processResultsWithStats(raw, '禁烟政策', 5);
    // Only the on-topic result survives
    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://gov.cn/1');
    // 2 dropped, all via intent_mismatch
    expect(stats.filtered_count).toBe(2);
    expect(stats.filter_reason).toBe('intent_mismatch');
  });

  it('counts dropped English results on long queries', () => {
    const raw = [
      baseResult({ title: 'transformer paper', snippet: 'attention is all you need', url: 'https://arxiv.org/1' }),
      baseResult({ title: 'cooking recipes', snippet: 'pasta carbonara', url: 'https://cook.com/2' }),
    ];
    const { results, stats } = processResultsWithStats(raw, 'transformer attention is all you need', 5);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://arxiv.org/1');
    expect(stats.filtered_count).toBe(1);
    expect(stats.filter_reason).toBe('intent_mismatch');
  });

  it('still respects maxResults on the survivor list', () => {
    const raw = Array.from({ length: 10 }, (_, i) =>
      baseResult({ title: `result ${i}`, snippet: 'q', url: `https://a.com/${i}` }),
    );
    const { results, stats } = processResultsWithStats(raw, 'q', 3);
    expect(results.length).toBe(3);
    expect(stats.filtered_count).toBe(0);
  });

  it('treats an all-spam result set as intent_mismatch (not low_quality)', () => {
    const raw = [
      baseResult({ title: 'NBA比分', snippet: '体育', url: 'https://sports.com/1' }),
      baseResult({ title: '英超', snippet: '足球', url: 'https://soccer.com/2' }),
    ];
    const { results, stats } = processResultsWithStats(raw, '禁烟政策', 5);
    expect(results.length).toBe(0);
    expect(stats.filtered_count).toBe(2);
    expect(stats.filter_reason).toBe('intent_mismatch');
  });
});
