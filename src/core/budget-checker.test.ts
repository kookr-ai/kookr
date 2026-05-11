import { describe, test, expect } from 'vitest';
import { BudgetChecker, readBudgetThresholdFromEnv } from './budget-checker.js';

describe('BudgetChecker', () => {
  test('returns null when cost is below threshold', () => {
    const checker = new BudgetChecker(5);
    expect(checker.check('task-1', 'agent-1', 4.99)).toBeNull();
    expect(checker.hasFired('task-1')).toEqual({ warning: false, critical: false });
  });

  test('fires warning when cost reaches threshold', () => {
    const checker = new BudgetChecker(5);
    const anomaly = checker.check('task-1', 'agent-1', 5);
    expect(anomaly).not.toBeNull();
    expect(anomaly?.type).toBe('budget_exceeded');
    expect(anomaly?.severity).toBe('warning');
    expect(anomaly?.agentId).toBe('agent-1');
    // Explanation must carry the actual cost, the threshold, and mark the
    // alert as reactive (contract from the issue acceptance criteria).
    expect(anomaly?.explanation).toBe(
      'Task cost $5.00 exceeds threshold ($5.00). Reactive alert — may overshoot by one turn.',
    );
  });

  test('fires critical when cost reaches 2x threshold', () => {
    const checker = new BudgetChecker(5);
    // Step 1: trigger warning with a value between threshold and 2x.
    expect(checker.check('task-1', 'agent-1', 6)?.severity).toBe('warning');
    // Step 2: cross 2x threshold with a value ABOVE 2x so the observed cost
    // and the printed 2x threshold are distinct. If the implementation ever
    // printed thresholdUsd instead of criticalThresholdUsd, the coincident
    // value $10 would hide the bug — use $12 vs. $10 instead.
    const critical = checker.check('task-1', 'agent-1', 12);
    expect(critical?.severity).toBe('critical');
    expect(critical?.explanation).toBe(
      'Task cost $12.00 exceeds 2x threshold ($10.00). Reactive alert — may overshoot by one turn.',
    );
  });

  test('jumps straight to critical when cost skips past warning', () => {
    const checker = new BudgetChecker(5);
    const anomaly = checker.check('task-1', 'agent-1', 20);
    expect(anomaly?.severity).toBe('critical');
    // Warning is marked delivered implicitly so we do not double-fire next tick.
    expect(checker.hasFired('task-1')).toEqual({ warning: true, critical: true });
  });

  test('does not re-fire same severity on subsequent ticks', () => {
    const checker = new BudgetChecker(5);
    expect(checker.check('task-1', 'agent-1', 5)?.severity).toBe('warning');
    // Cost continues climbing within the warning band — no new anomaly.
    expect(checker.check('task-1', 'agent-1', 6)).toBeNull();
    expect(checker.check('task-1', 'agent-1', 9.99)).toBeNull();
    // Crossing 2x fires critical exactly once.
    expect(checker.check('task-1', 'agent-1', 10)?.severity).toBe('critical');
    expect(checker.check('task-1', 'agent-1', 15)).toBeNull();
    expect(checker.check('task-1', 'agent-1', 100)).toBeNull();
  });

  test('tracks breach state per task independently', () => {
    const checker = new BudgetChecker(5);
    expect(checker.check('task-1', 'agent-1', 5)?.severity).toBe('warning');
    expect(checker.hasFired('task-1').warning).toBe(true);
    expect(checker.hasFired('task-2').warning).toBe(false);
    // task-2 fires on its own when its cost crosses.
    const anomaly = checker.check('task-2', 'agent-2', 5);
    expect(anomaly?.severity).toBe('warning');
    expect(anomaly?.agentId).toBe('agent-2');
    // Critical: task-1 must NOT re-fire after task-2 fires. A shared-state
    // regression (single boolean instead of per-task map) would let this
    // call return a second warning anomaly because the map would be reset
    // by task-2 somehow, or because state leaked across keys.
    expect(checker.check('task-1', 'agent-1', 5)).toBeNull();
    // And task-2 must also not re-fire warning on its own re-check.
    expect(checker.check('task-2', 'agent-2', 6)).toBeNull();
  });

  test('is disabled when threshold is 0 or negative', () => {
    for (const threshold of [0, -1]) {
      const checker = new BudgetChecker(threshold);
      expect(checker.check('task-1', 'agent-1', 1_000_000)).toBeNull();
      expect(checker.hasFired('task-1')).toEqual({ warning: false, critical: false });
    }
  });

  test('reset() allows re-firing for the same task', () => {
    const checker = new BudgetChecker(5);
    expect(checker.check('task-1', 'agent-1', 5)?.severity).toBe('warning');
    checker.reset('task-1');
    expect(checker.hasFired('task-1')).toEqual({ warning: false, critical: false });
    expect(checker.check('task-1', 'agent-1', 5)?.severity).toBe('warning');
  });

  test('stamps detectedAt from the provided clock', () => {
    const checker = new BudgetChecker(5);
    const now = new Date('2026-04-15T12:00:00Z');
    const anomaly = checker.check('task-1', 'agent-1', 5, now);
    expect(anomaly?.detectedAt).toEqual(now);
  });
});

describe('readBudgetThresholdFromEnv', () => {
  test('returns default when var is unset', () => {
    expect(readBudgetThresholdFromEnv({})).toBe(25);
  });

  test('returns default when var is blank', () => {
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: '' })).toBe(25);
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: '   ' })).toBe(25);
  });

  test('returns parsed value when var is a number', () => {
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: '10' }, 5)).toBe(10);
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: '2.5' }, 5)).toBe(2.5);
  });

  test('clamps negative values to 0 (disables check)', () => {
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: '-1' }, 5)).toBe(0);
  });

  test('falls back to default when var is garbage', () => {
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: 'not-a-number' })).toBe(25);
  });

  test('falls back to default for Infinity and -Infinity', () => {
    // Number('Infinity') === Infinity, which is NOT Number.isFinite — reject.
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: 'Infinity' })).toBe(25);
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: '-Infinity' })).toBe(25);
  });

  test('accepts scientific notation', () => {
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: '1e2' }, 5)).toBe(100);
  });

  test('allows explicit 0 to disable', () => {
    expect(readBudgetThresholdFromEnv({ KOOKR_BUDGET_WARN_USD: '0' }, 5)).toBe(0);
  });
});
