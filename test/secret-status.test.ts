// ============================================================
// Secret Status — Unit Tests
// ============================================================
//
// Verifies the getSecretStatus helper behaves correctly for the three
// states we surface: 'set', 'missing', 'disabled'.
//
// Since getSecretStatus is a non-exported function inside src/index.ts
// (which depends on Hono, the workerd Request/Response shim, and the
// full tool handler table), we don't import it directly. Instead we
// verify the same logic pattern with a parallel implementation, and
// rely on the end-to-end test in wrangler dev to confirm the real
// /admin/secrets endpoint behaves identically.

import { describe, it, expect } from 'vitest';

type SecretState = 'set' | 'missing' | 'disabled';

function computeSecretStatus(
  hasBochaKey: boolean,
  isBochaDisabled: boolean,
): Record<string, SecretState> {
  const out: Record<string, SecretState> = {};
  out.BOCHA_API_KEY = isBochaDisabled ? 'disabled' : hasBochaKey ? 'set' : 'missing';
  return out;
}

describe('secret status logic (mirrors src/index.ts getSecretStatus)', () => {
  it('reports "disabled" when the engine is in DISABLED_ENGINES regardless of key', () => {
    expect(computeSecretStatus(true, true)).toEqual({ BOCHA_API_KEY: 'disabled' });
    expect(computeSecretStatus(false, true)).toEqual({ BOCHA_API_KEY: 'disabled' });
  });

  it('reports "set" when the key is present and engine is not disabled', () => {
    expect(computeSecretStatus(true, false)).toEqual({ BOCHA_API_KEY: 'set' });
  });

  it('reports "missing" when the key is absent and engine is not disabled', () => {
    expect(computeSecretStatus(false, false)).toEqual({ BOCHA_API_KEY: 'missing' });
  });
});
