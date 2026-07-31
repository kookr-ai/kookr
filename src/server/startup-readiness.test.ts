import { describe, expect, it } from 'vitest';
import { StartupReadiness } from './startup-readiness.js';

describe('StartupReadiness (issue #1721)', () => {
  it('starts initializing and is not ready', () => {
    const gate = new StartupReadiness('2026-07-30T21:27:39.918Z');
    expect(gate.getPhase()).toBe('initializing');
    expect(gate.toReadinessCheck()).toMatchObject({
      critical: true,
      ready: false,
      status: 'initializing',
      reason: 'startup-in-progress',
    });
    expect(gate.getProgress()).toMatchObject({
      phase: 'initializing',
      startedAt: '2026-07-30T21:27:39.918Z',
    });
  });

  it('tracks listening → recovering → ready transitions', () => {
    const gate = new StartupReadiness();
    gate.markListening();
    expect(gate.getPhase()).toBe('listening');
    expect(gate.getProgress().listeningAt).toEqual(expect.any(String));
    expect(gate.toReadinessCheck().ready).toBe(false);

    gate.markRecovering('reattaching sessions');
    expect(gate.getPhase()).toBe('recovering');
    expect(gate.toReadinessCheck()).toMatchObject({
      ready: false,
      status: 'recovering',
      detail: 'reattaching sessions',
    });

    gate.markReady();
    expect(gate.getPhase()).toBe('ready');
    expect(gate.toReadinessCheck()).toEqual({
      critical: true,
      ready: true,
      status: 'ready',
    });
    expect(gate.getProgress().readyAt).toEqual(expect.any(String));
  });

  it('ignores regressions after ready', () => {
    const gate = new StartupReadiness();
    gate.markReady();
    gate.markListening('should not regress');
    gate.markRecovering('should not regress');
    expect(gate.getPhase()).toBe('ready');
    expect(gate.toReadinessCheck().ready).toBe(true);
  });
});
