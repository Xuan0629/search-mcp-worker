// ============================================================
// search-mcp-worker — Engine Circuit Breaker
// ============================================================
//
// Per-engine circuit breaker. When an engine returns 'blocked' quality
// (CAPTCHA / anti-bot / quota exhausted) N times in a window, the engine
// is "frozen" for a cooldown period and skipped by the router.
//
// Pattern borrowed from Kerry1020/search-mcp-worker (MIT-incompatible GPL-3.0
// code, re-implemented from scratch here under our MIT license).
//
// Storage: in-memory Map, hoisted onto `globalThis` so the state survives
// workerd isolate restarts on the same instance. Worker instances are still
// isolated from each other, but a single instance sees a continuous view
// across all its isolates.
//
// References:
//   - https://developers.cloudflare.com/workers/reference/how-workers-works/
//     "Modules that are loaded once and shared across isolates" — workerd
//     does hoist module-level constants, but mutable state on a module
//     closure is not guaranteed to survive isolate restart. Stashing on
//     `globalThis` is the conventional workaround for shared mutable state.

import { CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_FREEZE_MS } from './constants';

interface CircuitRecord {
  failures: number;
  frozenUntil: number; // epoch ms
  lastFailure: number; // epoch ms
  lastReason: string;
}

const STATE_KEY = '__search_mcp_circuit_breaker__';
type GlobalWithState = typeof globalThis & {
  [STATE_KEY]?: Map<string, CircuitRecord>;
};
const g = globalThis as GlobalWithState;
const records: Map<string, CircuitRecord> = g[STATE_KEY] ?? (g[STATE_KEY] = new Map());

/** Is this engine currently frozen and should be skipped? */
export function isEngineFrozen(engine: string): boolean {
  const r = records.get(engine);
  if (!r) return false;
  if (Date.now() > r.frozenUntil) {
    // Cooldown expired; clear so we get a clean retry
    records.delete(engine);
    return false;
  }
  return true;
}

/** Record a successful response from an engine — clears the failure counter. */
export function recordEngineSuccess(engine: string): void {
  records.delete(engine);
}

/** Record a blocked response. Increments counter; freezes engine at threshold.
 *
 * NOTE: This counter lives in a per-isolate Map (hoisted to globalThis). On
 * Cloudflare Workers, each request may run in a fresh isolate, so the count
 * is effectively per-request — it WILL NOT aggregate across requests on a
 * different isolate. The single-isolate behaviour is still useful for retry
 * storms within a single request, but for cross-request protection, prefer
 * `DISABLED_ENGINES` in index.ts.
 */
export function recordEngineBlocked(engine: string, reason: string): void {
  const r = records.get(engine) ?? {
    failures: 0,
    frozenUntil: 0,
    lastFailure: 0,
    lastReason: '',
  };
  r.failures += 1;
  r.lastFailure = Date.now();
  r.lastReason = reason;
  if (r.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    r.frozenUntil = Date.now() + CIRCUIT_BREAKER_FREEZE_MS;
    // Reset counter so a future escalation can re-freeze
    r.failures = 0;
  }
  records.set(engine, r);
}

/** Return a snapshot of current circuit state (for /health). */
export function getCircuitState(): Record<
  string,
  { frozen: boolean; frozenUntil?: number; lastReason?: string }
> {
  const now = Date.now();
  const out: Record<string, { frozen: boolean; frozenUntil?: number; lastReason?: string }> = {};
  for (const [engine, r] of records.entries()) {
    const frozen = now < r.frozenUntil;
    out[engine] = frozen
      ? { frozen: true, frozenUntil: r.frozenUntil, lastReason: r.lastReason }
      : { frozen: false, lastReason: r.lastReason };
  }
  return out;
}

/** Test-only: clear all state. */
export function _resetCircuitBreaker(): void {
  records.clear();
}
