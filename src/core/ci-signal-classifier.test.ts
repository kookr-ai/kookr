import { describe, test, expect } from 'vitest';
import {
  classifyCiSignal,
  decideMergeGate,
  DEFAULT_CI_DURATION_FLOOR_SECONDS,
  VERIFIED_LOCALLY_LABEL,
  type CiRunObservation,
  type CiSignalClassification,
} from './ci-signal-classifier.js';

describe('classifyCiSignal — signal-absent detection', () => {
  test('billing/spending-limit annotation ⇒ ci-signal-absent even when conclusion is failure', () => {
    const obs: CiRunObservation = {
      conclusion: 'failure',
      durationSeconds: 3,
      annotations: [
        'The job was not started because recent account payments have failed or your spending limit needs to be increased.',
      ],
    };
    const c = classifyCiSignal(obs);
    expect(c.class).toBe('ci-signal-absent');
    expect(c.signalAbsent).toBe(true);
    expect(c.reason).toMatch(/billing|spending/i);
  });

  test('assorted billing wordings all classify as signal-absent', () => {
    for (const note of [
      'You have exceeded your included quota of Actions minutes.',
      'Billing issue: payment method failed.',
      'Your account is out of minutes for this billing cycle.',
    ]) {
      expect(classifyCiSignal({ conclusion: 'failure', annotations: [note] }).class).toBe(
        'ci-signal-absent',
      );
    }
  });

  test('0 steps executed ⇒ ci-signal-absent (the billing-block fingerprint)', () => {
    const c = classifyCiSignal({ conclusion: 'failure', durationSeconds: 3, stepsExecuted: 0 });
    expect(c.class).toBe('ci-signal-absent');
    expect(c.reason).toMatch(/0 steps/i);
  });

  test('startup_failure conclusion ⇒ ci-signal-absent', () => {
    const c = classifyCiSignal({ conclusion: 'startup_failure' });
    expect(c.class).toBe('ci-signal-absent');
    expect(c.reason).toMatch(/startup/i);
  });

  test('sub-floor duration with a non-success conclusion ⇒ ci-signal-absent', () => {
    const c = classifyCiSignal({ conclusion: 'failure', durationSeconds: 3, stepsExecuted: 5 });
    expect(c.class).toBe('ci-signal-absent');
    expect(c.reason).toMatch(/floor/i);
  });

  test('duration exactly at the floor with a non-success conclusion ⇒ signal-absent', () => {
    const c = classifyCiSignal({
      conclusion: 'failure',
      durationSeconds: DEFAULT_CI_DURATION_FLOOR_SECONDS,
    });
    expect(c.class).toBe('ci-signal-absent');
  });

  test('custom duration floor is honored', () => {
    const obs: CiRunObservation = { conclusion: 'failure', durationSeconds: 20 };
    expect(classifyCiSignal(obs).class).toBe('ci-failed');
    expect(classifyCiSignal(obs, { durationFloorSeconds: 30 }).class).toBe('ci-signal-absent');
  });
});

describe('classifyCiSignal — genuine pass/fail are not downgraded', () => {
  test('a fast green run is ci-passed, not signal-absent (success never downgraded on duration)', () => {
    const c = classifyCiSignal({ conclusion: 'success', durationSeconds: 2, stepsExecuted: 4 });
    expect(c.class).toBe('ci-passed');
    expect(c.signalAbsent).toBe(false);
  });

  test('a real red run that executed steps and ran long enough is ci-failed', () => {
    const c = classifyCiSignal({ conclusion: 'failure', durationSeconds: 240, stepsExecuted: 30 });
    expect(c.class).toBe('ci-failed');
    expect(c.signalAbsent).toBe(false);
  });

  test('skipped and neutral conclusions are treated as passed (non-blocking)', () => {
    expect(classifyCiSignal({ conclusion: 'skipped' }).class).toBe('ci-passed');
    expect(classifyCiSignal({ conclusion: 'neutral' }).class).toBe('ci-passed');
  });

  test('cancelled / timed_out / action_required / null are ci-failed absent any signal-absent trigger', () => {
    for (const conclusion of ['cancelled', 'timed_out', 'action_required', null] as const) {
      expect(classifyCiSignal({ conclusion }).class).toBe('ci-failed');
    }
  });

  test('a red run with unknown timing and steps stays ci-failed (no false signal-absent)', () => {
    expect(classifyCiSignal({ conclusion: 'failure' }).class).toBe('ci-failed');
  });
});

function classification(cls: CiSignalClassification['class']): CiSignalClassification {
  return { class: cls, signalAbsent: cls === 'ci-signal-absent', reason: `test:${cls}` };
}

describe('decideMergeGate', () => {
  test('ci-passed ⇒ merge, no label, no retro-verify enqueue', () => {
    const d = decideMergeGate({ ci: classification('ci-passed') });
    expect(d.action).toBe('merge');
    expect(d.merge).toBe(true);
    expect(d.label).toBeUndefined();
    expect(d.enqueueRetroVerify).toBe(false);
    expect(d.finding).toBeUndefined();
  });

  test('ci-failed ⇒ block with a finding, never merge over a real red', () => {
    const d = decideMergeGate({ ci: classification('ci-failed') });
    expect(d.action).toBe('block-ci-failed');
    expect(d.merge).toBe(false);
    expect(d.finding).toMatch(/real red/i);
  });

  test('signal-absent with no local verification ⇒ block, require the local gate', () => {
    const d = decideMergeGate({ ci: classification('ci-signal-absent') });
    expect(d.action).toBe('block-local-required');
    expect(d.merge).toBe(false);
    expect(d.enqueueRetroVerify).toBe(false);
    expect(d.finding).toMatch(/no verification signal/i);
  });

  test('signal-absent but local suite not run ⇒ still blocked', () => {
    const d = decideMergeGate({
      ci: classification('ci-signal-absent'),
      local: { ran: false, passed: false },
    });
    expect(d.action).toBe('block-local-required');
    expect(d.merge).toBe(false);
  });

  test('signal-absent + local green ⇒ merge tagged verified-locally and enqueued for retro-verify', () => {
    const d = decideMergeGate({
      ci: classification('ci-signal-absent'),
      local: { ran: true, passed: true },
    });
    expect(d.action).toBe('merge-verified-locally');
    expect(d.merge).toBe(true);
    expect(d.label).toBe(VERIFIED_LOCALLY_LABEL);
    expect(d.enqueueRetroVerify).toBe(true);
  });

  test('signal-absent + local red ⇒ NOT merged, surfaces a finding with the summary', () => {
    const d = decideMergeGate({
      ci: classification('ci-signal-absent'),
      local: { ran: true, passed: false, summary: 'foo.test.ts > bar failed' },
    });
    expect(d.action).toBe('block-local-failed');
    expect(d.merge).toBe(false);
    expect(d.enqueueRetroVerify).toBe(false);
    expect(d.finding).toContain('foo.test.ts > bar failed');
  });
});

describe('classify → gate integration (acceptance criteria)', () => {
  test('a billing-blocked run only merges after the local suite passes, tagged verified-locally', () => {
    const obs: CiRunObservation = {
      conclusion: 'failure',
      durationSeconds: 3,
      stepsExecuted: 0,
      annotations: ['spending limit needs to be increased'],
    };
    const ci = classifyCiSignal(obs);
    expect(ci.class).toBe('ci-signal-absent');

    // Before running the local suite: blocked, not silently mergeable.
    expect(decideMergeGate({ ci }).merge).toBe(false);

    // Local green: merges, labelled verified-locally.
    const green = decideMergeGate({ ci, local: { ran: true, passed: true } });
    expect(green.merge).toBe(true);
    expect(green.label).toBe(VERIFIED_LOCALLY_LABEL);

    // Local red: never merged.
    const red = decideMergeGate({ ci, local: { ran: true, passed: false } });
    expect(red.merge).toBe(false);
    expect(red.finding).toBeDefined();
  });
});
