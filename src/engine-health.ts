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
