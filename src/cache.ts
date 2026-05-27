import type { CachedResponse, SearchResponse } from './types';
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES } from './constants';

export class SearchCache {
  private cache = new Map<string, CachedResponse>();

  get(key: string): SearchResponse | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: string, data: SearchResponse): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, {
      data: { ...data, cached: true },
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/** Generate a cache key from query parameters */
export function makeCacheKey(query: string, engines: string[], limit: number): string {
  return `auto:${engines.sort().join(',')}:${query}:${limit}`;
}
