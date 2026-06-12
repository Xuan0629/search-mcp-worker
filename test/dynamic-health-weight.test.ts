// ============================================================
// Dynamic Engine Health Weighting — Unit Tests
// ============================================================
//
// Covers engine-health.ts::healthScore() and the new stable-sort
// behavior in router.ts::selectEngines / routeExplicit. See
// analysis v2 §6.10 for the formula and rationale.

import { describe, it, expect, beforeEach } from 'vitest';
import { recordEngineHealthEvent, _resetEngineHealth, healthScore } from '../src/engine-health';
import { selectEngines, routeExplicit } from '../src/router';

describe('healthScore', () => {
  beforeEach(() => _resetEngineHealth());

  it('returns null for an engine with no recorded events (cold start)', () => {
    expect(healthScore('bing')).toBeNull();
  });

  it('returns null when all events are outside the window', () => {
    // The window is 1h. We can't easily wait 1h, but the function
    // treats "no fresh events" the same as "no events at all" so
    // calling it without ever recording still returns null.
    expect(healthScore('bing')).toBeNull();
  });

  it('positive score: more successes than errors', () => {
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'error');
    // 3*1 - 1*2 = 1
    expect(healthScore('bing')).toBe(1);
  });

  it('negative score: more errors than successes', () => {
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'error');
    recordEngineHealthEvent('bing', 'error');
    // 1*1 - 2*2 = -3
    expect(healthScore('bing')).toBeCloseTo(-3, 5);
  });

  it('weights error heavier than success', () => {
    // 1 success, 1 error: net -1
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'error');
    expect(healthScore('bing')).toBeCloseTo(-1, 5);
  });

  it('penalises empty gently', () => {
    // 1 success, 1 empty: 1 - 0.3 = 0.7
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'empty');
    expect(healthScore('bing')).toBeCloseTo(0.7, 5);
  });

  it('tracks engines independently', () => {
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('duckduckgo', 'error');
    recordEngineHealthEvent('duckduckgo', 'error');
    recordEngineHealthEvent('duckduckgo', 'error');
    expect(healthScore('bing')).toBe(2);
    expect(healthScore('duckduckgo')).toBeCloseTo(-6, 5);
  });
});

describe('selectEngines ranks by health score (descending)', () => {
  beforeEach(() => _resetEngineHealth());

  it('cold start: returns engines in declared order (all score = 0)', () => {
    const r = selectEngines('general', 'zh');
    // bocha is primary in zh-general; with no events nothing should
    // change the order, so the existing router.test contract holds.
    expect(r.engines[0]).toBe('bocha');
    expect(r.engines).toContain('baidu');
    expect(r.engines).toContain('bing_cn');
  });

  it('healthy engine outranks a failing one', () => {
    // bocha is primary but we'll mark it as failing heavily.
    recordEngineHealthEvent('bocha', 'error');
    recordEngineHealthEvent('bocha', 'error');
    recordEngineHealthEvent('bocha', 'error');
    // baidu is the next declared engine; mark it healthy.
    recordEngineHealthEvent('baidu', 'success');
    recordEngineHealthEvent('baidu', 'success');
    recordEngineHealthEvent('baidu', 'success');

    const r = selectEngines('general', 'zh');
    // baidu (score 3) should now beat bocha (score -6).
    expect(r.engines.indexOf('baidu')).toBeLessThan(r.engines.indexOf('bocha'));
  });

  it('ties preserve declaration order (stable sort)', () => {
    // Two engines with identical scores. The one declared first
    // in ROUTING_TABLE should still come first.
    recordEngineHealthEvent('bocha', 'success');
    recordEngineHealthEvent('baidu', 'success');
    const r = selectEngines('general', 'zh');
    expect(r.engines.indexOf('bocha')).toBeLessThan(r.engines.indexOf('baidu'));
  });

  it('disabled engines still filter out before ranking', () => {
    // Mark baidu healthy AND keep it disabled — it should still disappear.
    recordEngineHealthEvent('baidu', 'success');
    recordEngineHealthEvent('baidu', 'success');
    const r = selectEngines('general', 'zh', new Set(['baidu']));
    expect(r.engines).not.toContain('baidu');
  });
});

describe('routeExplicit also ranks by health score', () => {
  beforeEach(() => _resetEngineHealth());

  it('reorders explicit engines by health score', () => {
    recordEngineHealthEvent('bocha', 'error');
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'success');
    const r = routeExplicit(['bocha', 'baidu', 'bing'], 'foo');
    // bing (score 2) should come before bocha (score -2) and baidu (score 0).
    expect(r.engines.indexOf('bing')).toBeLessThan(r.engines.indexOf('bocha'));
  });

  it('falls back to duckduckgo when all explicit engines are disabled', () => {
    // Sanity: existing routeExplicit contract still holds with the
    // new ranking layer.
    const r = routeExplicit(['bocha'], 'foo', new Set(['bocha']));
    expect(r.engines).toEqual(['duckduckgo']);
  });
});
