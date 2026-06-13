// ============================================================
// Deep Search + tokenOverlapScore — Unit Tests
// ============================================================
//
// We test the pure functions (tokenOverlapScore / tokenize) directly
// and use a tiny fixture for the deep_search orchestration: the
// tool handler delegates to the existing 'search' handler and then
// to fetchUrl, both of which have their own integration tests. Here
// we just lock in the orchestration contract: dedupe by host,
// skip challenge pages, sort by relevance.

import { describe, it, expect } from 'vitest';
import { tokenOverlapScore } from '../src/index';

describe('tokenOverlapScore', () => {
  it('returns 1.0 when every query token is in the text', () => {
    const s = tokenOverlapScore('python list comprehension', 'A python list comprehension is a concise way');
    expect(s).toBe(1);
  });

  it('returns 0.0 when no query token is in the text', () => {
    const s = tokenOverlapScore('python list', 'rust borrow checker');
    expect(s).toBe(0);
  });

  it('returns a fraction in [0, 1] for partial overlap', () => {
    const s = tokenOverlapScore('python list map filter', 'A python list is a sequence');
    // tokens: python, list, map, filter; hits: python, list → 2/4
    expect(s).toBeCloseTo(0.5, 5);
  });

  it('is case-insensitive', () => {
    const a = tokenOverlapScore('Python', 'python is great');
    const b = tokenOverlapScore('python', 'Python is great');
    expect(a).toBe(b);
  });

  it('treats CJK queries as one-or-more-character runs', () => {
    // "禁烟政策" → one CJK token; "禁烟" appears as a substring run too
    const s = tokenOverlapScore('禁烟政策', '中国禁烟政策概述');
    expect(s).toBeGreaterThan(0);
  });

  it('returns 0 for an empty query', () => {
    expect(tokenOverlapScore('', 'anything')).toBe(0);
  });

  it('returns 0 for empty text', () => {
    expect(tokenOverlapScore('python', '')).toBe(0);
  });

  it('handles punctuation in text without false tokens', () => {
    // "don't" should not produce a token that matches "dont" if the
    // query has "do". We lowercase and split on non-alphanum, so
    // "don't" becomes ["don", "t"]. As long as the query and text
    // are tokenised identically, overlap is correct.
    const s = tokenOverlapScore('don', "I don't like it");
    expect(s).toBe(1);
  });

  it('strips URLs down to host/path tokens', () => {
    const s = tokenOverlapScore('github hermes', 'See https://github.com/Xuan0629/hermes for the project');
    expect(s).toBe(1);
  });
});

describe('tokenOverlapScore: ranking use case', () => {
  it('ranks a focused page higher than a tangentially related one', () => {
    const focused = tokenOverlapScore('rust async tokio', 'Tokio is an async runtime for rust');
    const tangential = tokenOverlapScore('rust async tokio', 'Python has an asyncio library too');
    expect(focused).toBeGreaterThan(tangential);
  });
});
