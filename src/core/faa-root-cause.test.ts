import { describe, expect, test } from 'vitest';
import {
  FAA_ROOT_CAUSES,
  classifyFaaRootCause,
  dominantFaaRootCause,
  emptyFaaRootCauseTally,
  type FaaRootCause,
} from './faa-root-cause.js';
import { DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS } from './completion/completion-ready-cleanup.js';
import type { Task } from './task-read-model.js';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const STALE = DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS; // 60 min

/** Minimal FAA-shaped task: inProgress + a completion_ready signal raised `ageMs` ago. */
function faaTask(ageMs: number, overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    prompt: 'do the thing',
    cwd: '/repo',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [],
    createdAt: new Date(NOW - ageMs - 1),
    updatedAt: new Date(NOW),
    pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW - ageMs).toISOString() },
    ...overrides,
  };
}

describe('classifyFaaRootCause', () => {
  test('null when the task is not in-progress', () => {
    expect(classifyFaaRootCause(faaTask(2 * STALE, { status: 'completed' }), { now: NOW })).toBeNull();
  });

  test('null when there is no completion_ready pending signal', () => {
    const noSignal = faaTask(2 * STALE);
    delete noSignal.pendingSignal;
    expect(classifyFaaRootCause(noSignal, { now: NOW })).toBeNull();
  });

  test('un-ageable malformed raisedAt → awaiting_poll (stays FAA so the tally sum invariant holds)', () => {
    expect(
      classifyFaaRootCause(faaTask(0, { pendingSignal: { kind: 'completion_ready', raisedAt: 'not-a-date' } }), { now: NOW }),
    ).toBe('awaiting_poll');
  });

  test('un-ageable future raisedAt (clock skew / hand-edited state) → awaiting_poll', () => {
    const future = faaTask(0, { pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW + 60_000).toISOString() } });
    expect(classifyFaaRootCause(future, { now: NOW })).toBe('awaiting_poll');
  });

  test('younger than the stale threshold → awaiting_poll (healthy baseline)', () => {
    expect(classifyFaaRootCause(faaTask(STALE - 1), { now: NOW })).toBe('awaiting_poll');
  });

  test('exactly at the stale threshold → no longer awaiting_poll', () => {
    // At the boundary it is a genuine stall; with no auto-close opt-in it is a config gap.
    expect(classifyFaaRootCause(faaTask(STALE), { now: NOW })).toBe('auto_close_disabled');
  });

  test('past threshold + autoCloseOnSignal → ack_sweep_backlog (sweep behind)', () => {
    expect(classifyFaaRootCause(faaTask(2 * STALE, { autoCloseOnSignal: true }), { now: NOW })).toBe('ack_sweep_backlog');
  });

  test('past TTL (not opted in) → ack_sweep_backlog via TTL escalation', () => {
    const ttlMs = 90 * 60_000;
    expect(classifyFaaRootCause(faaTask(2 * ttlMs), { now: NOW, ttlMs })).toBe('ack_sweep_backlog');
  });

  test('TTL boundary is inclusive: exactly at TTL escalates, one ms under does not', () => {
    const ttlMs = 90 * 60_000; // > 60-min stale threshold, so both ages are already past awaiting_poll
    expect(classifyFaaRootCause(faaTask(ttlMs), { now: NOW, ttlMs })).toBe('ack_sweep_backlog');
    expect(classifyFaaRootCause(faaTask(ttlMs - 1), { now: NOW, ttlMs })).toBe('auto_close_disabled');
  });

  test('autoCloseOnSignal + ask-first together → ack_sweep_backlog (opt-in precedes the human gate)', () => {
    expect(
      classifyFaaRootCause(
        faaTask(2 * STALE, { autoCloseOnSignal: true, deliveryAuthorization: 'ask-first' }),
        { now: NOW },
      ),
    ).toBe('ack_sweep_backlog');
  });

  test('past threshold + ask-first delivery → manual_review_gate (by design)', () => {
    expect(
      classifyFaaRootCause(faaTask(2 * STALE, { deliveryAuthorization: 'ask-first' }), { now: NOW }),
    ).toBe('manual_review_gate');
  });

  test('past threshold + not opted in + not ask-first → auto_close_disabled (config gap)', () => {
    expect(classifyFaaRootCause(faaTask(2 * STALE), { now: NOW })).toBe('auto_close_disabled');
  });

  test('ask-first but past TTL → ack_sweep_backlog (TTL escalation overrides the human gate)', () => {
    const ttlMs = 90 * 60_000;
    expect(
      classifyFaaRootCause(faaTask(2 * ttlMs, { deliveryAuthorization: 'ask-first' }), { now: NOW, ttlMs }),
    ).toBe('ack_sweep_backlog');
  });

  test('custom staleThresholdMs shifts the awaiting_poll boundary', () => {
    const task = faaTask(30 * 60_000); // 30 min old
    expect(classifyFaaRootCause(task, { now: NOW })).toBe('awaiting_poll'); // < 60 min default
    expect(classifyFaaRootCause(task, { now: NOW, staleThresholdMs: 10 * 60_000 })).toBe('auto_close_disabled');
  });
});

describe('emptyFaaRootCauseTally', () => {
  test('is all-zero over exactly the canonical cause set', () => {
    const tally = emptyFaaRootCauseTally();
    expect(Object.keys(tally).sort()).toEqual([...FAA_ROOT_CAUSES].sort());
    expect(Object.values(tally).every((n) => n === 0)).toBe(true);
  });
});

describe('dominantFaaRootCause', () => {
  test('null on an empty (all-zero) tally', () => {
    expect(dominantFaaRootCause(emptyFaaRootCauseTally())).toBeNull();
  });

  test('returns the strict max', () => {
    const tally: Record<FaaRootCause, number> = {
      awaiting_poll: 2,
      ack_sweep_backlog: 5,
      manual_review_gate: 1,
      auto_close_disabled: 0,
    };
    expect(dominantFaaRootCause(tally)).toBe('ack_sweep_backlog');
  });

  test('ties favor the actionable stall cause over the healthy baseline', () => {
    const tally: Record<FaaRootCause, number> = {
      awaiting_poll: 3,
      ack_sweep_backlog: 3,
      manual_review_gate: 0,
      auto_close_disabled: 0,
    };
    expect(dominantFaaRootCause(tally)).toBe('ack_sweep_backlog');
  });

  test('mid-priority tie: auto_close_disabled (config gap) beats manual_review_gate (by design)', () => {
    const tally: Record<FaaRootCause, number> = {
      awaiting_poll: 0,
      ack_sweep_backlog: 0,
      manual_review_gate: 2,
      auto_close_disabled: 2,
    };
    expect(dominantFaaRootCause(tally)).toBe('auto_close_disabled');
  });
});
