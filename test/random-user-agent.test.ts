// ============================================================
// randomUserAgent — Unit Tests
// ============================================================
//
// The UA pool rotation is a single-line helper, but it has two
// subtle invariants worth pinning down:
//   1. The function must return a value from the shared pool
//      (so we never accidentally inject a fixed worker UA).
//   2. The function must return *some* UA on every call
//      (USER_AGENTS.length > 0 is enforced by the constant but
//      the helper could in theory still hand back undefined).
//
// We don't test the randomness itself (it would be flaky) but
// we do test the distribution: 100 calls should hit at least 2
// different strings from a 8-string pool with overwhelming
// probability. P(all same) = (1/8)^99 ≈ 10^-91, so this is safe.

import { describe, it, expect } from 'vitest';
import { randomUserAgent } from '../src/utils/http';
import { USER_AGENTS } from '../src/constants';

describe('randomUserAgent', () => {
  it('returns a value from the shared USER_AGENTS pool', () => {
    for (let i = 0; i < 50; i++) {
      const ua = randomUserAgent();
      expect(USER_AGENTS).toContain(ua);
    }
  });

  it('returns a non-empty string', () => {
    const ua = randomUserAgent();
    expect(typeof ua).toBe('string');
    expect(ua.length).toBeGreaterThan(10);
  });

  it('returns different UAs across many calls (distribution sanity check)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(randomUserAgent());
    }
    // P(all 100 calls map to a single UA) with an 8-element pool
    // is (1/8)^99 ≈ 10^-91, so this is a safe lower bound.
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('USER_AGENTS contains at least one mobile entry', () => {
    // All production UA strings are mobile, because some upstreams
    // (notably Google) only serve full content to mobile UAs. The
    // pool is mobile-only for now; if a future change adds desktop
    // agents, add a parallel assertion.
    const hasMobile = USER_AGENTS.some((ua) => /Mobile|Android|iPhone/.test(ua));
    expect(hasMobile).toBe(true);
  });

  it('USER_AGENTS has at least 3 entries so the rotation is meaningful', () => {
    expect(USER_AGENTS.length).toBeGreaterThanOrEqual(3);
  });
});
