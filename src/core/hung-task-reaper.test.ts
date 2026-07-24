import { describe, expect, test } from 'vitest';
import { DEFAULT_HUNG_TASK_REAP_MS, evaluateHungTaskReap } from './hung-task-reaper.js';

const THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3h, matches the default
const NOW = Date.parse('2026-06-21T00:00:00.000Z');

function silentSince(ms: number) {
  return { lastHookEventAt: ms, lastPaneChangeAt: ms, lastTokenActivityAt: ms };
}

describe('evaluateHungTaskReap', () => {
  test('all channels silent past the threshold is eligible', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      silentSince(NOW - THRESHOLD_MS - 1),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: true, silentForMs: THRESHOLD_MS + 1 });
  });

  test('treats the boundary (silent for exactly thresholdMs) as eligible', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      silentSince(NOW - THRESHOLD_MS),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: true, silentForMs: THRESHOLD_MS });
  });

  test('any single live channel (hook events) keeps the task NOT reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      { lastHookEventAt: NOW - 60_000, lastPaneChangeAt: NOW - THRESHOLD_MS - 1, lastTokenActivityAt: NOW - THRESHOLD_MS - 1 },
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_silent_enough' });
  });

  test('any single live channel (pane change) keeps the task NOT reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      { lastHookEventAt: NOW - THRESHOLD_MS - 1, lastPaneChangeAt: NOW - 60_000, lastTokenActivityAt: NOW - THRESHOLD_MS - 1 },
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_silent_enough' });
  });

  test('any single live channel (token activity) keeps the task NOT reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      { lastHookEventAt: NOW - THRESHOLD_MS - 1, lastPaneChangeAt: NOW - THRESHOLD_MS - 1, lastTokenActivityAt: NOW - 60_000 },
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_silent_enough' });
  });

  test('a task with a pending signal is NEVER reaped, even if fully silent', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress', pendingSignal: { kind: 'completion_ready', raisedAt: '2026-06-20T00:00:00.000Z' } },
      silentSince(0),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'has_pending_signal' });
  });

  test('a task that has not launched yet (pending) is never reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'pending' },
      silentSince(0),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_in_progress' });
  });

  test('a terminal task is never reaped', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'completed' },
      silentSince(0),
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict).toEqual({ eligible: false, reason: 'not_in_progress' });
  });

  test('defaults thresholdMs to DEFAULT_HUNG_TASK_REAP_MS when omitted', () => {
    const justUnderDefault = evaluateHungTaskReap(
      { status: 'inProgress' },
      silentSince(NOW - DEFAULT_HUNG_TASK_REAP_MS + 1_000),
      { now: NOW },
    );
    expect(justUnderDefault.eligible).toBe(false);

    const pastDefault = evaluateHungTaskReap(
      { status: 'inProgress' },
      silentSince(NOW - DEFAULT_HUNG_TASK_REAP_MS - 1_000),
      { now: NOW },
    );
    expect(pastDefault.eligible).toBe(true);
  });

  test('zero (never recorded) activity timestamps count as silent since epoch', () => {
    const verdict = evaluateHungTaskReap(
      { status: 'inProgress' },
      { lastHookEventAt: 0, lastPaneChangeAt: 0, lastTokenActivityAt: 0 },
      { now: NOW, thresholdMs: THRESHOLD_MS },
    );
    expect(verdict.eligible).toBe(true);
  });
});
