import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '../shared/contracts/task-status.js';
import {
  classifySessionReapKind,
  decideSessionReap,
  isDtachUnderPressure,
  resolveEffectiveOrphanAgeMs,
  type SessionOwnership,
  type SessionReapConfig,
} from './session-reap-policy.js';

const HOUR_MS = 60 * 60 * 1000;
const STEADY_ORPHAN_AGE_MS = 24 * HOUR_MS;
const PRESSURE_ORPHAN_AGE_MS = 2 * HOUR_MS;

const DEFAULT_CONFIG: SessionReapConfig = {
  enabled: true,
  orphanAgeThresholdMs: STEADY_ORPHAN_AGE_MS,
  terminalTaskGraceMs: 60_000,
};

const UNOWNED: SessionOwnership = { kind: 'unowned' };

function owned(taskStatus: TaskStatus, sessionLastStatus?: string): SessionOwnership {
  return { kind: 'owned', taskId: 'task-1', taskStatus, sessionLastStatus };
}

describe('classifySessionReapKind', () => {
  it('classifies an unowned session', () => {
    expect(classifySessionReapKind(UNOWNED)).toBe('unowned');
  });

  it('classifies a session owned by a non-terminal task as active', () => {
    expect(classifySessionReapKind(owned('inProgress', 'running'))).toBe('active');
    expect(classifySessionReapKind(owned('open', undefined))).toBe('active');
    expect(classifySessionReapKind(owned('pending', undefined))).toBe('active');
  });

  it('classifies a session owned by a terminal-status task as a terminal-task leak', () => {
    expect(classifySessionReapKind(owned('completed', 'running'))).toBe('terminal-task-leak');
    expect(classifySessionReapKind(owned('terminated', 'running'))).toBe('terminal-task-leak');
    expect(classifySessionReapKind(owned('cancelled', 'running'))).toBe('terminal-task-leak');
  });

  it('classifies a session whose OWN lastStatus is already terminal as a leak, even if the task status lags', () => {
    // Mirrors reconciliation.ts's own skip check: a session record already
    // marked completed/aborted is never re-examined by reconcile(), so if its
    // process tree is still alive it must be caught here.
    expect(classifySessionReapKind(owned('inProgress', 'completed'))).toBe('terminal-task-leak');
    expect(classifySessionReapKind(owned('inProgress', 'aborted'))).toBe('terminal-task-leak');
  });
});

describe('decideSessionReap', () => {
  const now = 1_000_000_000_000; // fixed epoch ms for deterministic ages

  it('never reaps a session belonging to an active task, regardless of age', () => {
    const decision = decideSessionReap(
      's1',
      owned('inProgress', 'running'),
      now - 365 * 24 * HOUR_MS, // a year old
      now,
      DEFAULT_CONFIG,
    );
    expect(decision.shouldReap).toBe(false);
    expect(decision.kind).toBe('active');
  });

  it('does not reap an unowned session younger than the orphan age threshold', () => {
    const decision = decideSessionReap('s1', UNOWNED, now - 23 * HOUR_MS, now, DEFAULT_CONFIG);
    expect(decision.shouldReap).toBe(false);
    expect(decision.kind).toBe('unowned');
  });

  it('reaps an unowned session past the orphan age threshold (issue #1720 leak class 1)', () => {
    const decision = decideSessionReap('s1', UNOWNED, now - 25 * HOUR_MS, now, DEFAULT_CONFIG);
    expect(decision.shouldReap).toBe(true);
    expect(decision.kind).toBe('unowned');
    expect(decision.ageMs).toBe(25 * HOUR_MS);
  });

  it('does not race a mid-launch session: unknown age is never reaped', () => {
    const decision = decideSessionReap('s1', UNOWNED, null, now, DEFAULT_CONFIG);
    expect(decision.shouldReap).toBe(false);
    expect(decision.ageMs).toBeNull();
    expect(decision.reason).toMatch(/age unknown/);
  });

  it('reaps a session exactly AT the age threshold (boundary is inclusive: age >= threshold)', () => {
    const decision = decideSessionReap(
      's1',
      UNOWNED,
      now - DEFAULT_CONFIG.orphanAgeThresholdMs,
      now,
      DEFAULT_CONFIG,
    );
    expect(decision.ageMs).toBe(DEFAULT_CONFIG.orphanAgeThresholdMs);
    expect(decision.shouldReap).toBe(true);
  });

  it('does not reap a session exactly ONE ms younger than the age threshold', () => {
    const decision = decideSessionReap(
      's1',
      UNOWNED,
      now - DEFAULT_CONFIG.orphanAgeThresholdMs + 1,
      now,
      DEFAULT_CONFIG,
    );
    expect(decision.ageMs).toBe(DEFAULT_CONFIG.orphanAgeThresholdMs - 1);
    expect(decision.shouldReap).toBe(false);
  });

  it('clamps a future startedAtMs (clock skew) to zero age rather than a negative number', () => {
    const decision = decideSessionReap('s1', UNOWNED, now + HOUR_MS, now, DEFAULT_CONFIG);
    expect(decision.ageMs).toBe(0);
    expect(decision.shouldReap).toBe(false);
  });

  it('does not reap a terminal-task session inside the (much shorter) grace period', () => {
    const decision = decideSessionReap('s1', owned('completed', 'completed'), now - 30_000, now, DEFAULT_CONFIG);
    expect(decision.shouldReap).toBe(false);
    expect(decision.kind).toBe('terminal-task-leak');
  });

  it('reaps a terminal-task session past the grace period (issue #1720 leak class 2 — kookr-826a3ebe)', () => {
    const decision = decideSessionReap('s1', owned('completed', 'completed'), now - 90_000, now, DEFAULT_CONFIG);
    expect(decision.shouldReap).toBe(true);
    expect(decision.kind).toBe('terminal-task-leak');
  });

  it('uses the terminal grace threshold, not the (much larger) orphan age threshold, for owned leaks', () => {
    // 2 hours old: far below the 24h orphan threshold, but well past the 60s grace.
    const decision = decideSessionReap('s1', owned('terminated', 'running'), now - 2 * HOUR_MS, now, DEFAULT_CONFIG);
    expect(decision.shouldReap).toBe(true);
  });

  it('flag-off: never reaps anything regardless of kind or age', () => {
    const disabled: SessionReapConfig = { ...DEFAULT_CONFIG, enabled: false };
    const unownedOld = decideSessionReap('s1', UNOWNED, now - 48 * HOUR_MS, now, disabled);
    const leakOld = decideSessionReap('s2', owned('completed', 'completed'), now - HOUR_MS, now, disabled);
    expect(unownedOld.shouldReap).toBe(false);
    expect(unownedOld.reason).toMatch(/disabled/);
    expect(leakOld.shouldReap).toBe(false);
    expect(leakOld.reason).toMatch(/disabled/);
  });

  it('flag-off short-circuits before the age check even for a session with unknown age', () => {
    const disabled: SessionReapConfig = { ...DEFAULT_CONFIG, enabled: false };
    const decision = decideSessionReap('s1', UNOWNED, null, now, disabled);
    expect(decision.shouldReap).toBe(false);
    expect(decision.reason).toMatch(/disabled/);
  });

  it('under pressure: reaps unowned orphans past the 2h pressure threshold (issue #2081)', () => {
    // Config already carries the *effective* age (service resolves before call).
    const underPressureConfig: SessionReapConfig = {
      ...DEFAULT_CONFIG,
      orphanAgeThresholdMs: PRESSURE_ORPHAN_AGE_MS,
    };
    // 3h old: past 2h pressure threshold, well below 24h steady-state.
    const decision = decideSessionReap('s1', UNOWNED, now - 3 * HOUR_MS, now, underPressureConfig);
    expect(decision.shouldReap).toBe(true);
    expect(decision.kind).toBe('unowned');
  });

  it('without pressure: 3h orphan stays below the 24h default (issue #2081)', () => {
    const decision = decideSessionReap('s1', UNOWNED, now - 3 * HOUR_MS, now, DEFAULT_CONFIG);
    expect(decision.shouldReap).toBe(false);
    expect(decision.kind).toBe('unowned');
  });

  it('under pressure: does not reap an unowned session younger than the pressure threshold', () => {
    const underPressureConfig: SessionReapConfig = {
      ...DEFAULT_CONFIG,
      orphanAgeThresholdMs: PRESSURE_ORPHAN_AGE_MS,
    };
    const decision = decideSessionReap('s1', UNOWNED, now - HOUR_MS, now, underPressureConfig);
    expect(decision.shouldReap).toBe(false);
  });
});

describe('resolveEffectiveOrphanAgeMs (issue #2081)', () => {
  it('returns the steady-state age when not under pressure', () => {
    expect(resolveEffectiveOrphanAgeMs(STEADY_ORPHAN_AGE_MS, PRESSURE_ORPHAN_AGE_MS, false)).toBe(
      STEADY_ORPHAN_AGE_MS,
    );
  });

  it('returns the under-pressure age when under pressure', () => {
    expect(resolveEffectiveOrphanAgeMs(STEADY_ORPHAN_AGE_MS, PRESSURE_ORPHAN_AGE_MS, true)).toBe(
      PRESSURE_ORPHAN_AGE_MS,
    );
  });
});

describe('isDtachUnderPressure (issue #2081)', () => {
  it('is true when count is at or above the soft bound', () => {
    expect(isDtachUnderPressure(20, 20)).toBe(true);
    expect(isDtachUnderPressure(32, 20)).toBe(true);
  });

  it('is false when count is below the soft bound, null, or bound is disabled', () => {
    expect(isDtachUnderPressure(19, 20)).toBe(false);
    expect(isDtachUnderPressure(null, 20)).toBe(false);
    expect(isDtachUnderPressure(undefined, 20)).toBe(false);
    expect(isDtachUnderPressure(100, 0)).toBe(false);
    expect(isDtachUnderPressure(100, -1)).toBe(false);
  });
});
