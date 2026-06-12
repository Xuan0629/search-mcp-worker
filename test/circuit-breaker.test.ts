// ============================================================
// Circuit Breaker — Unit Tests
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isEngineFrozen,
  recordEngineSuccess,
  recordEngineBlocked,
  getCircuitState,
  _resetCircuitBreaker,
} from '../src/circuit-breaker';

describe('circuit-breaker', () => {
  beforeEach(() => _resetCircuitBreaker());

  it('engine is not frozen by default', () => {
    expect(isEngineFrozen('baidu')).toBe(false);
  });

  it('engine stays warm under the threshold', () => {
    recordEngineBlocked('baidu', '403 captcha');
    recordEngineBlocked('baidu', '403 captcha');
    expect(isEngineFrozen('baidu')).toBe(false);
  });

  it('engine is frozen after CIRCUIT_BREAKER_THRESHOLD blocked responses', () => {
    recordEngineBlocked('baidu', '403 captcha');
    recordEngineBlocked('baidu', '403 captcha');
    recordEngineBlocked('baidu', '403 captcha');
    expect(isEngineFrozen('baidu')).toBe(true);
  });

  it('recordEngineSuccess clears the failure counter', () => {
    recordEngineBlocked('baidu', '403 captcha');
    recordEngineBlocked('baidu', '403 captcha');
    recordEngineSuccess('baidu');
    recordEngineBlocked('baidu', '403 captcha');
    // Only one failure recorded, not three — engine stays warm.
    expect(isEngineFrozen('baidu')).toBe(false);
  });

  it('frozen state is exposed in getCircuitState()', () => {
    for (let i = 0; i < 3; i++) recordEngineBlocked('baidu', 'captcha');
    const state = getCircuitState();
    expect(state.baidu).toBeDefined();
    expect(state.baidu.frozen).toBe(true);
    expect(state.baidu.frozenUntil).toBeGreaterThan(Date.now());
    expect(state.baidu.lastReason).toBe('captcha');
  });

  it('engines are tracked independently', () => {
    for (let i = 0; i < 3; i++) recordEngineBlocked('baidu', 'captcha');
    expect(isEngineFrozen('baidu')).toBe(true);
    expect(isEngineFrozen('sogou')).toBe(false);
  });

  it('frozen state expires after the cooldown (via manual clock check)', () => {
    for (let i = 0; i < 3; i++) recordEngineBlocked('baidu', 'captcha');
    expect(isEngineFrozen('baidu')).toBe(true);
    // Manually clear via success
    recordEngineSuccess('baidu');
    expect(isEngineFrozen('baidu')).toBe(false);
  });
});
