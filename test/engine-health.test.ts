// ============================================================
// Engine Health — Unit Tests
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordEngineHealthEvent,
  getEngineHealthStats,
  _resetEngineHealth,
} from '../src/engine-health';

describe('engine-health', () => {
  beforeEach(() => _resetEngineHealth());

  it('returns empty stats for an unknown engine', () => {
    const stats = getEngineHealthStats();
    expect(stats).toEqual({});
  });

  it('counts success/error/empty per engine', () => {
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('bing', 'error');
    recordEngineHealthEvent('bing', 'empty');
    const stats = getEngineHealthStats();
    expect(stats.bing).toEqual({
      success: 2,
      error: 1,
      empty: 1,
      last_event_ts: expect.any(Number),
    });
  });

  it('tracks engines independently', () => {
    recordEngineHealthEvent('bing', 'success');
    recordEngineHealthEvent('duckduckgo', 'error');
    const stats = getEngineHealthStats();
    expect(stats.bing.success).toBe(1);
    expect(stats.bing.error).toBe(0);
    expect(stats.duckduckgo.success).toBe(0);
    expect(stats.duckduckgo.error).toBe(1);
  });

  it('last_event_ts reflects the most recent event', async () => {
    recordEngineHealthEvent('bing', 'success');
    await new Promise((r) => setTimeout(r, 5));
    recordEngineHealthEvent('bing', 'error');
    const stats = getEngineHealthStats();
    expect(stats.bing.last_event_ts).toBeGreaterThan(0);
    // Most recent is 'error', so counts should reflect that.
    expect(stats.bing.error).toBe(1);
  });
});
