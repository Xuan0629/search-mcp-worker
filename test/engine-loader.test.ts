// ============================================================
// Lazy Engine Loader — Unit Tests
// ============================================================
//
// The engine loader is a thin wrapper around dynamic import() + a Map
// cache hoisted onto globalThis. We can't easily import src/index.ts
// (it depends on Hono, the workerd Request/Response shim, and the full
// tool handler table), so we test the cache behaviour via a small
// re-implementation of the same pattern in isolation.
//
// What we're verifying here:
//   1. First call triggers a loader function.
//   2. Second call uses the cache (loader not called again).
//   3. The cache survives across "requests" when hoisted to globalThis
//      (simulated by re-importing after the cache is populated).
//   4. The reset helper clears state.
//
// This is intentionally a pattern test, not a test of the real
// loadEngine function. The real function is verified end-to-end in
// the worker via 'wrangler dev' / 'wrangler deploy'.

import { describe, it, expect, beforeEach } from 'vitest';

const CACHE_KEY = '__test_lazy_cache__';
type CacheEntry = string;
type Cache = Map<string, CacheEntry>;
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Cache };

const g = globalThis as GlobalWithCache;

function getCache(): Cache {
  return g[CACHE_KEY] ?? (g[CACHE_KEY] = new Map());
}

async function loadOrCache(
  name: string,
  loader: () => Promise<CacheEntry>,
): Promise<CacheEntry> {
  const cache = getCache();
  if (cache.has(name)) return cache.get(name)!;
  const value = await loader();
  cache.set(name, value);
  return value;
}

function resetCache(): void {
  g[CACHE_KEY]?.clear();
}

describe('lazy loader pattern (mirrors src/index.ts loadEngine)', () => {
  beforeEach(() => resetCache());

  it('first call triggers the loader', async () => {
    let calls = 0;
    const result = await loadOrCache('bocha', async () => {
      calls++;
      return 'bocha-module';
    });
    expect(result).toBe('bocha-module');
    expect(calls).toBe(1);
  });

  it('second call uses the cache (no extra loader call)', async () => {
    let calls = 0;
    const loader = async () => { calls++; return 'value'; };
    const a = await loadOrCache('k', loader);
    const b = await loadOrCache('k', loader);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('different keys use different loaders', async () => {
    let aCalls = 0, bCalls = 0;
    await loadOrCache('a', async () => { aCalls++; return 'A'; });
    await loadOrCache('b', async () => { bCalls++; return 'B'; });
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  it('cache survives across "isolates" (shared via globalThis)', async () => {
    let calls = 0;
    const loader = async () => { calls++; return 'shared'; };
    // First "isolate" loads
    await loadOrCache('shared', loader);
    // Simulate second isolate arriving: re-read globalThis cache
    const cacheInNewIsolate = (globalThis as GlobalWithCache)[CACHE_KEY]!;
    expect(cacheInNewIsolate.get('shared')).toBe('shared');
    expect(calls).toBe(1); // loader was only called once across both
  });

  it('reset clears the cache', async () => {
    let calls = 0;
    const loader = async () => { calls++; return 'x'; };
    await loadOrCache('k', loader);
    expect(calls).toBe(1);
    resetCache();
    await loadOrCache('k', loader);
    expect(calls).toBe(2);
  });
});
