import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearWaitingOnInputTracking,
  getStuckFlagPrecision,
  recordWaitingOnInputOutcome,
  resetStuckFlagPrecision,
} from './stuck-flag-precision.js';

describe('stuck-flag precision counter (#1653)', () => {
  beforeEach(() => resetStuckFlagPrecision());

  test('starts empty with null precision (no observations yet)', () => {
    expect(getStuckFlagPrecision()).toEqual({ flags: 0, suppressed: 0, precision: null });
  });

  test('counts distinct episodes and derives precision', () => {
    recordWaitingOnInputOutcome('a', 'flag');
    recordWaitingOnInputOutcome('b', 'flag');
    recordWaitingOnInputOutcome('c', 'suppressed');
    // 2 real flags, 1 would-be false positive suppressed → 2/3 precision.
    expect(getStuckFlagPrecision()).toEqual({ flags: 2, suppressed: 1, precision: 2 / 3 });
  });

  test('edge-triggered: repeated identical outcome for the same agent (polling) is not re-counted', () => {
    for (let i = 0; i < 50; i++) recordWaitingOnInputOutcome('poller', 'suppressed');
    // 50 polls of the same suppressed episode → a single suppressed tick.
    expect(getStuckFlagPrecision()).toMatchObject({ flags: 0, suppressed: 1 });
  });

  test('a transition flag↔suppressed for the same agent counts as a new episode', () => {
    recordWaitingOnInputOutcome('x', 'flag');
    recordWaitingOnInputOutcome('x', 'suppressed'); // agent started working
    recordWaitingOnInputOutcome('x', 'flag'); // went idle again
    expect(getStuckFlagPrecision()).toMatchObject({ flags: 2, suppressed: 1 });
  });

  test('clearing an agent lets its next identical outcome count as a fresh episode', () => {
    recordWaitingOnInputOutcome('y', 'flag');
    recordWaitingOnInputOutcome('y', 'flag'); // deduped
    expect(getStuckFlagPrecision()).toMatchObject({ flags: 1 });
    clearWaitingOnInputTracking('y'); // left needs_input, then re-entered
    recordWaitingOnInputOutcome('y', 'flag');
    expect(getStuckFlagPrecision()).toMatchObject({ flags: 2 });
  });

  test('all-flags → precision 1 (no false alarms suppressed)', () => {
    recordWaitingOnInputOutcome('a', 'flag');
    recordWaitingOnInputOutcome('b', 'flag');
    expect(getStuckFlagPrecision()).toEqual({ flags: 2, suppressed: 0, precision: 1 });
  });

  test('all-suppressed → precision 0 (every episode was a false alarm)', () => {
    recordWaitingOnInputOutcome('a', 'suppressed');
    recordWaitingOnInputOutcome('b', 'suppressed');
    expect(getStuckFlagPrecision()).toEqual({ flags: 0, suppressed: 2, precision: 0 });
  });

  test('reset clears the counters and per-agent memory', () => {
    recordWaitingOnInputOutcome('a', 'flag');
    resetStuckFlagPrecision();
    expect(getStuckFlagPrecision()).toEqual({ flags: 0, suppressed: 0, precision: null });
    // memory cleared too: the same agent+outcome counts again.
    recordWaitingOnInputOutcome('a', 'flag');
    expect(getStuckFlagPrecision()).toMatchObject({ flags: 1 });
  });
});
