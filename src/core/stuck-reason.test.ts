import { describe, expect, test } from 'vitest';
import {
  deriveStuckReason,
  isWaitingOnInputSuppressedByLiveness,
  DEFAULT_WAITING_ON_INPUT_LIVENESS_GRACE_MS,
} from './stuck-reason.js';
import type { HungTaskLivenessEvidence } from './hung-task-reaper.js';

describe('deriveStuckReason', () => {
  test('not inProgress → null, regardless of other signals', () => {
    for (const status of ['open', 'pending', 'completed', 'terminated', 'cancelled'] as const) {
      expect(
        deriveStuckReason({
          status,
          pendingSignal: { kind: 'completion_ready' },
          hungSuspect: true,
          anomalyType: 'permission_blocked',
        }),
      ).toBeNull();
    }
  });

  test('pendingSignal completion_ready → awaiting_completion_ack, highest priority', () => {
    const reason = deriveStuckReason({
      status: 'inProgress',
      pendingSignal: { kind: 'completion_ready' },
      hungSuspect: true,
      anomalyType: 'permission_blocked',
    });
    expect(reason).toBe('awaiting_completion_ack');
  });

  test('hungSuspect true (no pendingSignal) → hung_suspect', () => {
    const reason = deriveStuckReason({ status: 'inProgress', hungSuspect: true, anomalyType: null });
    expect(reason).toBe('hung_suspect');
  });

  test('anomalyType stale_agent alone (hungSuspect omitted) also maps to hung_suspect', () => {
    const reason = deriveStuckReason({ status: 'inProgress', anomalyType: 'stale_agent' });
    expect(reason).toBe('hung_suspect');
  });

  test('anomalyType needs_input → waiting_on_input', () => {
    const reason = deriveStuckReason({ status: 'inProgress', hungSuspect: false, anomalyType: 'needs_input' });
    expect(reason).toBe('waiting_on_input');
  });

  test('anomalyType permission_blocked → permission_blocked', () => {
    const reason = deriveStuckReason({ status: 'inProgress', hungSuspect: false, anomalyType: 'permission_blocked' });
    expect(reason).toBe('permission_blocked');
  });

  test('boundary: watchdog state absent (hungSuspect omitted, no anomaly) → null, i.e. genuinely working', () => {
    const reason = deriveStuckReason({ status: 'inProgress' });
    expect(reason).toBeNull();
  });

  test('an unrelated anomaly type (e.g. repeated_error) does not produce a stuck reason', () => {
    const reason = deriveStuckReason({ status: 'inProgress', hungSuspect: false, anomalyType: 'repeated_error' });
    expect(reason).toBeNull();
  });

  test('inProgress with no signals at all → null', () => {
    expect(deriveStuckReason({ status: 'inProgress' })).toBeNull();
  });

  test('needs_input without liveness/now supplied still flags (backward compatible)', () => {
    // Both older callers and any path that can't cheaply read watchdog state
    // omit liveness/now — behaviour must be unchanged from before #1653.
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', now: 1_000 })).toBe('waiting_on_input');
    const liveness: HungTaskLivenessEvidence = { lastHookEventAt: 500, lastPaneChangeAt: 0, lastTokenActivityAt: 0 };
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', liveness })).toBe('waiting_on_input');
  });
});

describe('deriveStuckReason waiting_on_input liveness cross-check (#1653)', () => {
  const NOW = 1_800_000_000_000;
  // Silent past the grace window on every channel → genuinely idle at the prompt.
  const IDLE: HungTaskLivenessEvidence = {
    lastHookEventAt: NOW - 5 * 60_000,
    lastPaneChangeAt: NOW - 5 * 60_000,
    lastTokenActivityAt: NOW - 5 * 60_000,
  };

  // The four 2026-07-27/28 dogfooding-night scenarios (issue #1653): three
  // actively-working agents that must NOT be flagged, and the one genuinely
  // idle Codex agent that must still flag. `needs_input` was the live watchdog
  // verdict in every row; the liveness channels are what disprove three of them.
  test('4140dedd (#1581 implement): spinner + token counter animating → suppressed', () => {
    const liveness: HungTaskLivenessEvidence = {
      lastHookEventAt: NOW - 20 * 60_000, // hook window quiet
      lastPaneChangeAt: NOW - 2_000, // spinner redraw
      lastTokenActivityAt: NOW - 3_000, // token counter animating
    };
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', liveness, now: NOW })).toBeNull();
  });

  test('2611e593 (orchestrator gen-2): "1 shell still running", cogitating → suppressed', () => {
    const liveness: HungTaskLivenessEvidence = {
      lastHookEventAt: NOW - 15_000, // running shell keeps hooks warm
      lastPaneChangeAt: NOW - 10 * 60_000,
      lastTokenActivityAt: NOW - 40_000,
    };
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', liveness, now: NOW })).toBeNull();
  });

  test('b8c511d4 (implement child): "2 shells still running", mid-merge → suppressed', () => {
    const liveness: HungTaskLivenessEvidence = {
      lastHookEventAt: NOW - 5_000,
      lastPaneChangeAt: NOW - 8_000, // merge output scrolling
      lastTokenActivityAt: NOW - 6 * 60_000,
    };
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', liveness, now: NOW })).toBeNull();
  });

  test('97402539 (Codex daily sync): genuinely idle at the prompt → still flagged (true positive)', () => {
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', liveness: IDLE, now: NOW })).toBe(
      'waiting_on_input',
    );
  });

  test('boundary: activity exactly at the grace edge still flags (>= grace is not "recent")', () => {
    const liveness: HungTaskLivenessEvidence = {
      lastHookEventAt: NOW - DEFAULT_WAITING_ON_INPUT_LIVENESS_GRACE_MS,
      lastPaneChangeAt: 0,
      lastTokenActivityAt: 0,
    };
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', liveness, now: NOW })).toBe(
      'waiting_on_input',
    );
  });

  test('livenessGraceMs override widens/narrows the suppression window', () => {
    const liveness: HungTaskLivenessEvidence = { lastHookEventAt: NOW - 90_000, lastPaneChangeAt: 0, lastTokenActivityAt: 0 };
    // 90s-old activity: default 60s grace flags it...
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', liveness, now: NOW })).toBe('waiting_on_input');
    // ...but a caller-supplied 120s grace suppresses it.
    expect(
      deriveStuckReason({ status: 'inProgress', anomalyType: 'needs_input', liveness, now: NOW, livenessGraceMs: 120_000 }),
    ).toBeNull();
  });

  test('liveness cross-check does not touch permission_blocked or hung_suspect', () => {
    const liveness: HungTaskLivenessEvidence = { lastHookEventAt: NOW - 1_000, lastPaneChangeAt: 0, lastTokenActivityAt: 0 };
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'permission_blocked', liveness, now: NOW })).toBe(
      'permission_blocked',
    );
    expect(deriveStuckReason({ status: 'inProgress', anomalyType: 'stale_agent', liveness, now: NOW })).toBe('hung_suspect');
  });

  test('isWaitingOnInputSuppressedByLiveness reflects the recent-activity predicate', () => {
    const recent: HungTaskLivenessEvidence = { lastHookEventAt: NOW - 1_000, lastPaneChangeAt: 0, lastTokenActivityAt: 0 };
    expect(isWaitingOnInputSuppressedByLiveness({ liveness: recent, now: NOW })).toBe(true);
    expect(isWaitingOnInputSuppressedByLiveness({ liveness: IDLE, now: NOW })).toBe(false);
    // Missing evidence is never a suppression.
    expect(isWaitingOnInputSuppressedByLiveness({ now: NOW })).toBe(false);
    expect(isWaitingOnInputSuppressedByLiveness({ liveness: recent })).toBe(false);
  });
});
