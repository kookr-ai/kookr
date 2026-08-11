import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEPLOY_STALE_RESIDUAL_THRESHOLDS,
  evaluateDeployStaleResidual,
} from './deploy-stale-residual.js';

const STALE = DEFAULT_DEPLOY_STALE_RESIDUAL_THRESHOLDS.staleMs;
const COOLDOWN = DEFAULT_DEPLOY_STALE_RESIDUAL_THRESHOLDS.cooldownMs;
const T0 = Date.parse('2026-08-11T08:00:00.000Z');

describe('evaluateDeployStaleResidual (issue #2226)', () => {
  it('does not alert while behindCount is 0', () => {
    const r = evaluateDeployStaleResidual({
      behindCount: 0,
      deploying: false,
      behindIdleSinceMs: T0 - STALE * 2,
      lastAlertedAtMs: null,
      firing: false,
      nowMs: T0,
    });
    expect(r.action).toBe('none');
    expect(r.stale).toBe(false);
    expect(r.nextBehindIdleSinceMs).toBeNull();
  });

  it('does not alert while deploying=true even if long-behind', () => {
    const r = evaluateDeployStaleResidual({
      behindCount: 19,
      deploying: true,
      behindIdleSinceMs: T0 - STALE * 3,
      lastAlertedAtMs: null,
      firing: false,
      nowMs: T0,
    });
    expect(r.action).toBe('none');
    expect(r.nextBehindIdleSinceMs).toBeNull();
    expect(r.message).toMatch(/deploying=true/i);
  });

  it('starts the idle clock on first behind+idle observation without alerting', () => {
    const r = evaluateDeployStaleResidual({
      behindCount: 3,
      deploying: false,
      behindIdleSinceMs: null,
      lastAlertedAtMs: null,
      firing: false,
      nowMs: T0,
    });
    expect(r.action).toBe('none');
    expect(r.nextBehindIdleSinceMs).toBe(T0);
    expect(r.stale).toBe(false);
    expect(r.ageMs).toBe(0);
  });

  it('alerts when behindCount>0 + deploying=false for ≥T (AC residual)', () => {
    const r = evaluateDeployStaleResidual({
      behindCount: 19,
      deploying: false,
      behindIdleSinceMs: T0 - STALE,
      lastAlertedAtMs: null,
      firing: false,
      nowMs: T0,
    });
    expect(r.action).toBe('alert');
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBe(STALE);
    expect(r.message).toMatch(/STALE DEPLOY/i);
    expect(r.message).toMatch(/behindCount=19/);
  });

  it('stays silent inside the stale window', () => {
    const r = evaluateDeployStaleResidual({
      behindCount: 2,
      deploying: false,
      behindIdleSinceMs: T0 - (STALE - 1),
      lastAlertedAtMs: null,
      firing: false,
      nowMs: T0,
    });
    expect(r.action).toBe('none');
    expect(r.stale).toBe(false);
  });

  it('respects re-page cooldown while residual remains high', () => {
    const r = evaluateDeployStaleResidual({
      behindCount: 5,
      deploying: false,
      behindIdleSinceMs: T0 - STALE * 2,
      lastAlertedAtMs: T0 - 1_000,
      firing: true,
      nowMs: T0,
    });
    expect(r.action).toBe('none');
    expect(r.stale).toBe(true);
  });

  it('re-pages after cooldown while still behind+idle', () => {
    const r = evaluateDeployStaleResidual({
      behindCount: 5,
      deploying: false,
      behindIdleSinceMs: T0 - STALE * 2,
      lastAlertedAtMs: T0 - COOLDOWN,
      firing: true,
      nowMs: T0,
    });
    expect(r.action).toBe('alert');
  });

  it('emits recover when residual clears (behindCount drops or deploy starts)', () => {
    const clearBehind = evaluateDeployStaleResidual({
      behindCount: 0,
      deploying: false,
      behindIdleSinceMs: T0 - STALE,
      lastAlertedAtMs: T0 - 60_000,
      firing: true,
      nowMs: T0,
    });
    expect(clearBehind.action).toBe('recover');
    expect(clearBehind.nextBehindIdleSinceMs).toBeNull();

    const clearDeploying = evaluateDeployStaleResidual({
      behindCount: 4,
      deploying: true,
      behindIdleSinceMs: T0 - STALE,
      lastAlertedAtMs: T0 - 60_000,
      firing: true,
      nowMs: T0,
    });
    expect(clearDeploying.action).toBe('recover');
  });

  it('honors threshold overrides', () => {
    const r = evaluateDeployStaleResidual({
      behindCount: 2,
      deploying: false,
      behindIdleSinceMs: T0 - 5_000,
      lastAlertedAtMs: null,
      firing: false,
      nowMs: T0,
      thresholds: { minBehindCount: 3, staleMs: 1_000 },
    });
    // behindCount 2 < min 3
    expect(r.action).toBe('none');
    expect(r.nextBehindIdleSinceMs).toBeNull();

    const r2 = evaluateDeployStaleResidual({
      behindCount: 3,
      deploying: false,
      behindIdleSinceMs: T0 - 5_000,
      lastAlertedAtMs: null,
      firing: false,
      nowMs: T0,
      thresholds: { minBehindCount: 3, staleMs: 1_000 },
    });
    expect(r2.action).toBe('alert');
  });
});
