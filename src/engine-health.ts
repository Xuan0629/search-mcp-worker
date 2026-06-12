// ============================================================
// search-mcp-worker — Engine Health Stats
// ============================================================
//
// Lightweight per-engine event log used to populate /health. We track
// success / error counts in a 1-hour rolling window so stale noise from
// yesterday's outage doesn't show up as if it just happened.
//
// Pattern borrowed from Kerry1020/search-mcp-worker (re-derived; see
// circuit-breaker.ts header for license notes).
//
// State is hoisted onto `globalThis` so that all isolates on the same
// worker instance see the same view. See circuit-breaker.ts for the
// why-this-is-needed rationale.

import { ENGINE_HEALTH_WINDOW_MS } from './constants';

export type EngineHealthEvent = 'success' | 'error' | 'empty';

interface HealthRecord {
  events: Array<{ event: EngineHealthEvent; ts: number }>;
}

const STATE_KEY = '__search_mcp_engine_health__';
type GlobalWithState = typeof globalThis & {
  [STATE_KEY]?: Map<string, HealthRecord>;
};
const g = globalThis as GlobalWithState;
const records: Map<string, HealthRecord> = g[STATE_KEY] ?? (g[STATE_KEY] = new Map());

/** Record a health event for an engine. */
export function recordEngineHealthEvent(engine: string, event: EngineHealthEvent): void {
  let r = records.get(engine);
  if (!r) {
    r = { events: [] };
    records.set(engine, r);
  }
  const now = Date.now();
  r.events.push({ event, ts: now });
  // Trim events outside the window to keep memory bounded.
  r.events = r.events.filter((e) => now - e.ts < ENGINE_HEALTH_WINDOW_MS);
}

/** Return counts of success/error/empty per engine over the health window. */
export function getEngineHealthStats(): Record<
  string,
  { success: number; error: number; empty: number; last_event_ts?: number }
> {
  const now = Date.now();
  const out: Record<
    string,
    { success: number; error: number; empty: number; last_event_ts?: number }
  > = {};
  for (const [engine, r] of records.entries()) {
    const fresh = r.events.filter((e) => now - e.ts < ENGINE_HEALTH_WINDOW_MS);
    const stats = { success: 0, error: 0, empty: 0, last_event_ts: undefined as number | undefined };
    for (const e of fresh) {
      stats[e.event]++;
      if (stats.last_event_ts === undefined || e.ts > stats.last_event_ts) {
        stats.last_event_ts = e.ts;
      }
    }
    out[engine] = stats;
  }
  return out;
}

/** Test-only: clear all health state. */
export function _resetEngineHealth(): void {
  records.clear();
}

/**
 * Compute a "health score" for an engine based on its 1-hour event log.
 *
 * The score is used by the router to rank candidate engines so that
 * currently-healthy ones are queried first, and recently-broken ones
 * (a flurry of errors in the last hour) sink to the back of the race.
 *
 * Formula (see analysis v2 §6.10):
 *     score = success * 1.0
 *           - error   * 2.0   // 'error' covers 5xx, CAPTCHA, quota
 *           - empty   * 0.3
 *
 * Rationale:
 *   - error > success weight: one blocked call hurts more than one
 *     success helps, because the cost of routing a query to a dead
 *     engine (timeout) is much larger than the cost of skipping a
 *     marginally-healthy one.
 *   - empty weight: empty ≠ broken (it just means the query had no
 *     good match on that engine), so we penalize it gently.
 *
 * Engines with zero recorded events (cold start) get `null` so the
 * router can keep them in their declared priority slot rather than
 * sinking them below warm-but-empty engines.
 */
export function healthScore(engine: string): number | null {
  const r = records.get(engine);
  if (!r || r.events.length === 0) return null;
  const now = Date.now();
  const fresh = r.events.filter((e) => now - e.ts < ENGINE_HEALTH_WINDOW_MS);
  if (fresh.length === 0) return null;
  let success = 0;
  let error = 0;
  let empty = 0;
  for (const e of fresh) {
    if (e.event === 'success') success++;
    else if (e.event === 'error') error++;
    else if (e.event === 'empty') empty++;
  }
  return success * 1.0 - error * 2.0 - empty * 0.3;
}
