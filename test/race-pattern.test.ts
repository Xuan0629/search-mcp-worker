// ============================================================
// Race-Pattern Engine Execution — Unit Tests
// ============================================================
//
// The race pattern in src/index.ts ('search' tool) is the meat of the
// search pipeline: it fires every selected engine concurrently and
// waits up to SEARCH_RACE_TIMEOUT_MS for stragglers. We can't easily
// import src/index.ts (Hono + workerd shim dependencies), so we
// re-implement the same race algorithm here in isolation and verify
// its semantics against a synthetic set of fast / slow / error engines.

import { describe, it, expect } from 'vitest';

const RACE_TIMEOUT_MS = 100; // keep tests fast

type Settled =
  | { engine: string; results: number[] }
  | { engine: string; error: string };

/** Mirror of the src/index.ts race pattern, parametrised for testing. */
async function runRace(
  engines: Array<{
    name: string;
    delay: number;
    fail?: boolean;
  }>,
  timeoutMs: number,
): Promise<{
  results: number[];
  attempted: string[];
  timedOut: string[];
}> {
  const allResults: number[] = [];
  const attempted: string[] = [];
  const timedOut: string[] = [];

  const settledFlags: boolean[] = engines.map(() => false);
  const workResults: Settled[] = engines.map(() => ({ engine: '', error: 'never-ran' }));
  const work: Promise<void>[] = engines.map(async (e, i) => {
    try {
      await new Promise((r) => setTimeout(r, e.delay));
      if (e.fail) {
        workResults[i] = { engine: e.name, error: 'engine-failed' };
      } else {
        workResults[i] = { engine: e.name, results: [i, i * 10] };
      }
    } catch (err) {
      workResults[i] = { engine: e.name, error: String(err) };
    } finally {
      settledFlags[i] = true;
    }
  });

  await Promise.race([
    Promise.all(work).then(() => ({ kind: 'done' as const })),
    new Promise<{ kind: 'timeout' }>((resolve) =>
      setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs),
    ),
  ]);

  for (let i = 0; i < engines.length; i++) {
    attempted.push(engines[i].name);
    if (settledFlags[i]) {
      const v = workResults[i];
      if ('results' in v) {
        allResults.push(...v.results);
      }
      // errors are silently dropped (engine didn't contribute)
    } else {
      timedOut.push(engines[i].name);
    }
  }
  return { results: allResults, attempted, timedOut };
}

describe('race-pattern engine execution', () => {
  it('returns all results when all engines finish in time', async () => {
    const r = await runRace(
      [
        { name: 'fast-1', delay: 5 },
        { name: 'fast-2', delay: 10 },
        { name: 'fast-3', delay: 15 },
      ],
      RACE_TIMEOUT_MS,
    );
    expect(r.attempted).toEqual(['fast-1', 'fast-2', 'fast-3']);
    expect(r.timedOut).toEqual([]);
    expect(r.results.sort()).toEqual([0, 0, 1, 10, 2, 20]);
  });

  it('marks slow engines as timed out without waiting for them', async () => {
    const start = Date.now();
    const r = await runRace(
      [
        { name: 'fast', delay: 5 },
        { name: 'slow', delay: 5000 }, // would take 5s
      ],
      RACE_TIMEOUT_MS,
    );
    const elapsed = Date.now() - start;
    // We should bail out in ~RACE_TIMEOUT_MS, not 5s.
    expect(elapsed).toBeLessThan(500);
    expect(r.attempted).toEqual(['fast', 'slow']);
    expect(r.timedOut).toEqual(['slow']);
    // The fast engine's results made it through.
    expect(r.results).toEqual([0, 0]);
  });

  it('records engine errors as "attempted but no results"', async () => {
    const r = await runRace(
      [
        { name: 'good', delay: 5 },
        { name: 'bad', delay: 10, fail: true },
      ],
      RACE_TIMEOUT_MS,
    );
    expect(r.attempted).toEqual(['good', 'bad']);
    expect(r.timedOut).toEqual([]);
    // The failing engine's results are silently dropped.
    expect(r.results).toEqual([0, 0]);
  });

  it('handles a mix: one fast, one slow, one errored', async () => {
    const r = await runRace(
      [
        { name: 'fast', delay: 5 },
        { name: 'err', delay: 10, fail: true },
        { name: 'slow', delay: 5000 },
      ],
      RACE_TIMEOUT_MS,
    );
    expect(r.attempted).toEqual(['fast', 'err', 'slow']);
    expect(r.timedOut).toEqual(['slow']);
    // The errored engine is NOT timed out — it settled (with an error).
    expect(r.results).toEqual([0, 0]);
  });

  it('returns empty results when all engines time out', async () => {
    const r = await runRace(
      [
        { name: 'a', delay: 5000 },
        { name: 'b', delay: 5000 },
      ],
      RACE_TIMEOUT_MS,
    );
    expect(r.timedOut.sort()).toEqual(['a', 'b']);
    expect(r.results).toEqual([]);
  });
});
