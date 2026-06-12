// ============================================================
// Router — Unit Tests (disabled engines filtering)
// ============================================================

import { describe, it, expect } from 'vitest';
import { selectEngines, route, routeExplicit } from '../src/router';

describe('selectEngines with disabledEngines', () => {
  it('returns all engines when disabled set is undefined', () => {
    const r = selectEngines('general', 'zh');
    expect(r.engines).toContain('bocha');
    expect(r.engines).toContain('baidu');
  });

  it('excludes disabled engines from the result', () => {
    const r = selectEngines('general', 'zh', new Set(['bocha']));
    expect(r.engines).not.toContain('bocha');
    // Other engines should still be there
    expect(r.engines.length).toBeGreaterThan(0);
  });

  it('disabled engine disappears from primary slot', () => {
    // For Chinese general, bocha is primary; disabling it should shift to next.
    const r = selectEngines('general', 'zh', new Set(['bocha']));
    expect(r.engines[0]).toBe('baidu');
  });
});

describe('route with disabledEngines', () => {
  it('integrates disabled filtering into full routing pipeline', () => {
    const r = route('hello world', new Set(['bocha']));
    expect(r.engines).not.toContain('bocha');
  });
});

describe('routeExplicit with disabledEngines', () => {
  it('excludes disabled engines from explicit list', () => {
    const r = routeExplicit(['bocha', 'baidu', 'bing'], 'foo', new Set(['bocha']));
    expect(r.engines).not.toContain('bocha');
    expect(r.engines).toContain('baidu');
    expect(r.engines).toContain('bing');
  });

  it('falls back to duckduckgo when all explicit engines are disabled', () => {
    const r = routeExplicit(['bocha'], 'foo', new Set(['bocha']));
    expect(r.engines).toEqual(['duckduckgo']);
  });
});
