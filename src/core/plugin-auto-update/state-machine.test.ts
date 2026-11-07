import { describe, test, expect } from 'vitest';
import {
  nextAutoUpdateState,
  isTerminalAutoUpdateState,
  IllegalAutoUpdateTransitionError,
  type AutoUpdateState,
  type AutoUpdateEvent,
} from './state-machine.js';

describe('auto-update state machine', () => {
  test('skip path: evaluating --skip--> skipped (terminal)', () => {
    expect(nextAutoUpdateState('evaluating', 'skip')).toBe('skipped');
    expect(isTerminalAutoUpdateState('skipped')).toBe(true);
  });

  test('working states are NOT terminal; verify-failed IS a recorded terminal state', () => {
    for (const s of ['evaluating', 'applying', 'verifying', 'rolling-back'] as const) {
      expect(isTerminalAutoUpdateState(s)).toBe(false);
    }
    // verify-failed is BOTH a recorded terminal state AND a legal rollback source.
    expect(isTerminalAutoUpdateState('verify-failed')).toBe(true);
    expect(nextAutoUpdateState('verify-failed', 'restore-ok')).toBe('rolled-back');
  });

  test('happy apply path reaches applied', () => {
    let s: AutoUpdateState = 'evaluating';
    s = nextAutoUpdateState(s, 'proceed');
    expect(s).toBe('applying');
    s = nextAutoUpdateState(s, 'apply-ok');
    expect(s).toBe('verifying');
    s = nextAutoUpdateState(s, 'verify-ok');
    expect(s).toBe('applied');
    expect(isTerminalAutoUpdateState(s)).toBe(true);
  });

  test('apply error path reaches failed', () => {
    const s = nextAutoUpdateState(nextAutoUpdateState('evaluating', 'proceed'), 'apply-error');
    expect(s).toBe('failed');
    expect(isTerminalAutoUpdateState(s)).toBe(true);
  });

  test('verify-fail routes through verify-failed then rollback', () => {
    let s: AutoUpdateState = nextAutoUpdateState('applying', 'apply-ok'); // verifying
    s = nextAutoUpdateState(s, 'verify-fail');
    expect(s).toBe('verify-failed');
    const rolledBack = nextAutoUpdateState(s, 'restore-ok');
    expect(rolledBack).toBe('rolled-back');
    const rollbackFailed = nextAutoUpdateState('verify-failed', 'restore-fail');
    expect(rollbackFailed).toBe('rollback-failed');
    expect(isTerminalAutoUpdateState('rolled-back')).toBe(true);
    expect(isTerminalAutoUpdateState('rollback-failed')).toBe(true);
  });

  test.each<[AutoUpdateState, AutoUpdateEvent]>([
    ['evaluating', 'apply-ok'],
    ['applying', 'skip'],
    ['verifying', 'proceed'],
    ['applied', 'verify-ok'],
    ['skipped', 'proceed'],
    ['rolled-back', 'restore-ok'],
  ])('illegal transition %s --%s--> throws', (state, event) => {
    expect(() => nextAutoUpdateState(state, event)).toThrow(IllegalAutoUpdateTransitionError);
  });
});
