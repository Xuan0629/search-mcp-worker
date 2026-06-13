// ============================================================
// search-mcp-worker — KV (L2) Cross-Isolate Cache
// ============================================================
//
// L1 (in-memory Map) lives in src/cache.ts and is per-isolate, so
// it goes cold on every new CF Workers isolate. L2 (this file) is
// a Cloudflare KV namespace that all isolates share, so a query
// result computed by one isolate can be served by another without
// re-running the engines.
//
// Strategy (see analysis v2 §6.12):
//   - Writes are fire-and-forget: cache.set() in src/cache.ts is
//     the source of truth, and we call kvCacheSet() after with a
//     `void` discard so a KV failure never blocks the user response.
//   - Reads happen only on cold start via warmup(): we pull up to
//     KV_CACHE_WARMUP_LIMIT recent entries and seed the L1 cache.
//     This bounds startup cost to ~100 KV reads (~500ms) and avoids
//     adding latency to hot paths.
//   - TTL is 1h (KV_CACHE_TTL_MS) vs L1's 5min. The longer L2 TTL
//     is OK because KV writes cost free-tier quota; we don't want
//     churn. Engine-health also uses a 1h window so the two are
//     consistent in spirit.
//
// Free-tier awareness:
//   - CF KV free plan: 100K reads/day, 1K writes/day. We write on
//     every search response, so at ~50-200 q/day the free tier is
//     safe with headroom. If we ever exceed, the writes silently
//     fail (we swallow the error) and L1 keeps working.
//
// License: derived from analysis v2 §6.12, original implementation.

import type { SearchResponse } from './types';
import { KV_CACHE_TTL_MS, KV_CACHE_WARMUP_LIMIT } from './constants';

// Serialised wire format stored in KV. Wrapping SearchResponse with
// an expiresAt stamp lets warmup() drop stale entries without
// re-checking wall-clock against the L1 convention (which uses its
// own 5min TTL). The two timeouts are different by design.
interface SerializedEntry {
  data: SearchResponse;
  expiresAt: number;
}

/**
 * Write to KV and return whether it succeeded. Awaited (not
 * fire-and-forget) so callers can report the result in the
 * response's _meta block. Original fire-and-forget version is
 * kept as kvCacheSetFireAndForget for cases where the caller
 * doesn't need the result.
 *
 * Returns:
 *   - true:  KV put resolved without error
 *   - false: KV binding absent, or put rejected (logged via console.warn)
 */
export async function kvCacheSet(
  kv: KVNamespace | undefined,
  key: string,
  data: SearchResponse,
): Promise<boolean> {
  if (!kv) {
    // No binding in this environment (e.g. test harness).
    return false;
  }
  const entry: SerializedEntry = {
    data,
    expiresAt: Date.now() + KV_CACHE_TTL_MS,
  };
  try {
    await kv.put(key, JSON.stringify(entry), {
      expirationTtl: Math.ceil(KV_CACHE_TTL_MS / 1000),
    });
    return true;
  } catch (err) {
    console.warn(`[kv-cache] write failed for key=${key}: ${err}`);
    return false;
  }
}

/**
 * Original fire-and-forget variant. Kept for callers that want
 * to fire-and-forget (e.g. from inside an SSE stream where the
 * response is already on the wire). Most callers should prefer
 * the awaited kvCacheSet so the result is observable.
 */
export function kvCacheSetFireAndForget(
  kv: KVNamespace | undefined,
  key: string,
  data: SearchResponse,
): void {
  if (!kv) return;
  void kvCacheSet(kv, key, data).catch(() => {
    // kvCacheSet already logs; this catch just prevents an
    // unhandled rejection if something throws synchronously.
  });
}

/**
 * Read a single entry from KV. Returns undefined on miss, parse
 * failure, or expiry. Used by tests and (optionally) for an
 * explicit read path; the hot path uses warmup() instead.
 */
export async function kvCacheGet(
  kv: KVNamespace,
  key: string,
): Promise<SearchResponse | undefined> {
  const raw = await kv.get(key);
  if (!raw) return undefined;
  try {
    const entry = JSON.parse(raw) as SerializedEntry;
    if (Date.now() > entry.expiresAt) {
      // Stale; treat as miss. KV's own expirationTtl should have
      // evicted it, but TTL granularity is 60s so we double-check.
      return undefined;
    }
    return entry.data;
  } catch {
    return undefined;
  }
}

/**
 * Cold-start hydration: pull the most recent N entries from KV and
 * return the data so the caller can seed the L1 cache. Returns up
 * to KV_CACHE_WARMUP_LIMIT entries; older ones are left in KV
 * (they'll TTL out naturally).
 *
 * The returned `Map<key, data>` is keyed by the KV key name and
 * contains only non-expired entries. Stale entries (within KV's
 * 60s eviction granularity) are dropped.
 *
 * Implementation note: KV's `list()` is paginated and returns
 * metadata, not values. For our small N (100) we list with limit
 * 100, then issue one `get()` per key. That's 100+1 round trips
 * to KV. Acceptable for cold start (one-time per isolate) but
 * would be wrong for hot path.
 */
export async function warmup(
  kv: KVNamespace,
): Promise<{ hydrated: Map<string, SearchResponse>; errors: number }> {
  const hydrated = new Map<string, SearchResponse>();
  let errors = 0;
  try {
    const list = await kv.list({ limit: KV_CACHE_WARMUP_LIMIT });
    // Parallelise the per-key gets to keep cold-start latency
    // bounded. KV read is free-tier friendly; ~10ms each but
    // concurrent they finish in ~20ms.
    const entries = await Promise.allSettled(
      list.keys.map((k) => kv.get(k.name)),
    );
    const now = Date.now();
    for (let i = 0; i < list.keys.length; i++) {
      const r = entries[i];
      const key = list.keys[i].name;
      if (r.status !== 'fulfilled' || !r.value) {
        errors++;
        continue;
      }
      try {
        const entry = JSON.parse(r.value) as SerializedEntry;
        if (now > entry.expiresAt) continue;
        hydrated.set(key, entry.data);
      } catch {
        errors++;
      }
    }
  } catch (err) {
    // KV list failure is fatal for warmup but not for the request;
    // we just log and return empty so the worker can still serve.
    console.warn(`[kv-cache] warmup failed: ${err}`);
  }
  return { hydrated, errors };
}

