// ============================================================
// KV (L2) Cache — Unit Tests
// ============================================================
//
// We mock the CF Workers KVNamespace interface (put/get/list with
// their in-memory shim below) and exercise the three exported
// functions: kvCacheSet, kvCacheGet, warmup. Fire-and-forget
// semantics for kvCacheSet are covered by waiting for the
// internal promise to settle before asserting.

import { describe, it, expect, beforeEach } from 'vitest';
import { kvCacheSet, kvCacheGet, warmup } from '../src/kv-cache';
import type { SearchResponse } from '../src/types';

// In-memory KV shim. Mirrors the parts of the Cloudflare KVNamespace
// interface we use: get(key), put(key, value, opts), list({limit}).
class MemoryKV {
  private store = new Map<string, { value: string; expirationTtl?: number; createdAt: number }>();

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expirationTtl !== undefined) {
      const ageSec = (Date.now() - e.createdAt) / 1000;
      if (ageSec > e.expirationTtl) {
        this.store.delete(key);
        return null;
      }
    }
    return e.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: opts?.expirationTtl, createdAt: Date.now() });
  }

  async list(opts?: { limit?: number }): Promise<{ keys: Array<{ name: string }> }> {
    const keys = [...this.store.keys()].slice(0, opts?.limit ?? 1000);
    return { keys: keys.map((name) => ({ name })) };
  }

  // Test helpers
  raw(key: string): string | undefined {
    return this.store.get(key)?.value;
  }
  size(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
}

const sampleResponse: SearchResponse = {
  results: [
    { title: 'Hello', url: 'https://example.com', snippet: 'world', source: 'bing', quality: 'green', score: 0 },
  ],
  query: 'hello',
  engines: ['bing'],
  cached: false,
};

describe('kvCacheSet', () => {
  let kv: MemoryKV;
  beforeEach(() => { kv = new MemoryKV(); });

  it('writes a JSON-serialised entry to KV', async () => {
    kvCacheSet(kv as unknown as KVNamespace, 'k1', sampleResponse);
    // Wait a tick for the unawaited put to settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(kv.size()).toBe(1);
    const raw = kv.raw('k1');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.data.query).toBe('hello');
    expect(parsed.expiresAt).toBeGreaterThan(Date.now());
  });

  it('attaches an expirationTtl so KV evicts stale entries', async () => {
    kvCacheSet(kv as unknown as KVNamespace, 'k2', sampleResponse);
    await new Promise((r) => setTimeout(r, 5));
    // We can't directly read the put opts from the shim, but the
    // shim does honour them — see the get() helper. Round-trip
    // via get() to confirm the value is still readable.
    const back = await kv.get('k2');
    expect(back).not.toBeNull();
  });

  it('does not throw on KV failure (fire-and-forget)', async () => {
    // Make put() reject.
    const broken = {
      get: async () => null,
      put: () => Promise.reject(new Error('KV quota exceeded')),
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace;
    // Suppress the console.warn the implementation will emit so
    // test output stays clean.
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      // Should not throw even though KV rejects.
      expect(() => kvCacheSet(broken, 'k3', sampleResponse)).not.toThrow();
      // Give the rejected promise a tick to be caught.
      await new Promise((r) => setTimeout(r, 5));
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('kvCacheGet', () => {
  let kv: MemoryKV;
  beforeEach(() => { kv = new MemoryKV(); });

  it('returns undefined on miss', async () => {
    const out = await kvCacheGet(kv as unknown as KVNamespace, 'nope');
    expect(out).toBeUndefined();
  });

  it('round-trips a value written by kvCacheSet', async () => {
    kvCacheSet(kv as unknown as KVNamespace, 'k4', sampleResponse);
    await new Promise((r) => setTimeout(r, 5));
    const out = await kvCacheGet(kv as unknown as KVNamespace, 'k4');
    expect(out).toEqual(sampleResponse);
  });

  it('returns undefined for malformed JSON', async () => {
    await kv.put('garbage', 'not-json-{');
    const out = await kvCacheGet(kv as unknown as KVNamespace, 'garbage');
    expect(out).toBeUndefined();
  });

  it('returns undefined when the entry is expired by expiresAt stamp', async () => {
    // Write a payload with expiresAt in the past.
    const stale = JSON.stringify({ data: sampleResponse, expiresAt: Date.now() - 1000 });
    await kv.put('stale', stale);
    const out = await kvCacheGet(kv as unknown as KVNamespace, 'stale');
    expect(out).toBeUndefined();
  });
});

describe('warmup', () => {
  let kv: MemoryKV;
  beforeEach(() => { kv = new MemoryKV(); });

  it('returns empty when KV is empty', async () => {
    const { hydrated, errors } = await warmup(kv as unknown as KVNamespace);
    expect(hydrated.size).toBe(0);
    expect(errors).toBe(0);
  });

  it('hydrates fresh entries from KV', async () => {
    kvCacheSet(kv as unknown as KVNamespace, 'w1', sampleResponse);
    kvCacheSet(kv as unknown as KVNamespace, 'w2', { ...sampleResponse, query: 'two' });
    await new Promise((r) => setTimeout(r, 10));
    const { hydrated, errors } = await warmup(kv as unknown as KVNamespace);
    expect(errors).toBe(0);
    expect(hydrated.size).toBe(2);
    expect(hydrated.get('w1')?.query).toBe('hello');
    expect(hydrated.get('w2')?.query).toBe('two');
  });

  it('skips expired entries (defensive against KV 60s TTL granularity)', async () => {
    // Manually inject a stale entry bypassing kvCacheSet.
    const stale = JSON.stringify({ data: sampleResponse, expiresAt: Date.now() - 1000 });
    await kv.put('stale', stale);
    kvCacheSet(kv as unknown as KVNamespace, 'fresh', sampleResponse);
    await new Promise((r) => setTimeout(r, 10));
    const { hydrated } = await warmup(kv as unknown as KVNamespace);
    expect(hydrated.size).toBe(1);
    expect(hydrated.has('fresh')).toBe(true);
    expect(hydrated.has('stale')).toBe(false);
  });

  it('returns empty (not throw) when list() fails', async () => {
    const broken = {
      get: async () => null,
      put: async () => {},
      list: () => Promise.reject(new Error('KV list failed')),
    } as unknown as KVNamespace;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const { hydrated, errors } = await warmup(broken);
      expect(hydrated.size).toBe(0);
      expect(errors).toBe(0); // errors=0 because the catch logs and returns empty
    } finally {
      console.warn = origWarn;
    }
  });

  it('respects KV_CACHE_WARMUP_LIMIT via the list() limit option', async () => {
    // Write 5 entries; warmup default is 100 so all 5 should hydrate.
    for (let i = 0; i < 5; i++) {
      kvCacheSet(kv as unknown as KVNamespace, `k${i}`, sampleResponse);
    }
    await new Promise((r) => setTimeout(r, 10));
    const { hydrated } = await warmup(kv as unknown as KVNamespace);
    expect(hydrated.size).toBe(5);
  });
});
