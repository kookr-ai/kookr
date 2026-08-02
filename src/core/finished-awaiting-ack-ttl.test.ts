import { describe, it, expect } from 'vitest';
import {
  listExpiredFinishedAwaitingAckTasks,
  DEFAULT_FINISHED_AWAITING_ACK_TTL_MS,
  MAX_FINISHED_AWAITING_ACK_TTL_MS,
} from './finished-awaiting-ack-ttl.js';
import type { Task } from './task-read-model.js';

const NOW = new Date('2026-08-02T12:00:00Z');

function faaTask(overrides: Partial<Task> = {}): Task {
  const raisedAt = overrides.pendingSignal?.raisedAt ?? new Date(NOW.getTime() - 5 * 60_000).toISOString();
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2)}`,
    prompt: 'do work',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [],
    createdAt: new Date(NOW.getTime() - 60 * 60_000),
    updatedAt: NOW,
    pendingSignal: { kind: 'completion_ready', raisedAt },
    ...overrides,
  } as Task;
}

describe('listExpiredFinishedAwaitingAckTasks (issue #1884)', () => {
  const ttlMs = 15 * 60_000; // 15m default, readable offsets

  it('selects an aged finishedAwaitingAck task with no PR hold', () => {
    const stale = faaTask({
      id: 'stale',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['stale']);
    expect(expired[0].ageMs).toBe(ttlMs + 60_000);
  });

  it('exempts an aged finishedAwaitingAck task that holds an open PR (stranded-PR / merge_required exemption)', () => {
    const stale = faaTask({
      id: 'stranded-pr',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => true,
    });
    expect(expired).toEqual([]);
  });

  it('does not select a finishedAwaitingAck task younger than the TTL', () => {
    const fresh = faaTask({
      id: 'fresh',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs + 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([fresh], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('does not select a non-finishedAwaitingAck inProgress task (no completion_ready pendingSignal)', () => {
    const working = faaTask({
      id: 'working',
      pendingSignal: undefined,
      createdAt: new Date(NOW.getTime() - 10 * ttlMs),
    });
    const askFirst = faaTask({
      id: 'other-signal',
      pendingSignal: { kind: 'ask_first' as unknown as 'completion_ready', raisedAt: new Date(NOW.getTime() - 10 * ttlMs).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([working, askFirst], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('exempts a task when PR-hold status is unknown/unavailable (fail-safe default)', () => {
    const stale = faaTask({
      id: 'unknown-pr-state',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => undefined,
    });
    expect(expired).toEqual([]);
  });

  it('exempts every candidate when no isHoldingOpenPr predicate is wired at all (same fail-safe default)', () => {
    const stale = faaTask({
      id: 'no-predicate',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([stale], { now: NOW, ttlMs });
    expect(expired).toEqual([]);
  });

  it('ignores statuses other than inProgress regardless of a stray completion_ready-shaped signal', () => {
    const completed = faaTask({ id: 'completed', status: 'completed', createdAt: new Date(NOW.getTime() - 10 * ttlMs) });
    const cancelled = faaTask({ id: 'cancelled', status: 'cancelled', createdAt: new Date(NOW.getTime() - 10 * ttlMs) });
    const expired = listExpiredFinishedAwaitingAckTasks([completed, cancelled], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('boundary: exactly at the TTL reclaims (inclusive)', () => {
    const boundary = faaTask({
      id: 'boundary',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs).toISOString() },
    });
    const justUnder = faaTask({
      id: 'under',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs + 1).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([boundary, justUnder], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['boundary']);
  });

  it('skips a task with a missing or unparseable raisedAt rather than surfacing a bogus age', () => {
    const bogus = faaTask({
      id: 'bogus',
      pendingSignal: { kind: 'completion_ready', raisedAt: 'not-a-date' },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([bogus], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('returns oldest-first', () => {
    const older = faaTask({
      id: 'older',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - 3 * ttlMs).toISOString() },
    });
    const newer = faaTask({
      id: 'newer',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - 2 * ttlMs).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([newer, older], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['older', 'newer']);
  });

  it('defaults the TTL to 15 minutes, hard-capped at 30 minutes', () => {
    expect(DEFAULT_FINISHED_AWAITING_ACK_TTL_MS).toBe(15 * 60_000);
    expect(MAX_FINISHED_AWAITING_ACK_TTL_MS).toBe(30 * 60_000);
    const justUnderDefault = faaTask({
      id: 'under-default',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - DEFAULT_FINISHED_AWAITING_ACK_TTL_MS + 1).toISOString(),
      },
    });
    const overDefault = faaTask({
      id: 'over-default',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - DEFAULT_FINISHED_AWAITING_ACK_TTL_MS).toISOString(),
      },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([justUnderDefault, overDefault], {
      now: NOW,
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['over-default']);
  });
});
