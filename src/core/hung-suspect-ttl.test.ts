import { describe, it, expect } from 'vitest';
import {
  listExpiredHungSuspectTasks,
  DEFAULT_HUNG_SUSPECT_TTL_MS,
  MAX_HUNG_SUSPECT_TTL_MS,
} from './hung-suspect-ttl.js';
import type { HungTaskLivenessEvidence } from './hung-task-reaper.js';
import type { Task } from './task-read-model.js';

const NOW = new Date('2026-08-03T12:00:00Z');
const TTL_MS = 25 * 60_000;

function hungTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2)}`,
    prompt: 'do work',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [],
    createdAt: new Date(NOW.getTime() - 60 * 60_000),
    updatedAt: NOW,
    ...overrides,
  } as Task;
}

function silentFor(ms: number): HungTaskLivenessEvidence {
  const last = NOW.getTime() - ms;
  return {
    lastHookEventAt: last,
    lastPaneChangeAt: last - 1_000,
    lastTokenActivityAt: last - 2_000,
  };
}

const alwaysHung = () => true;
const neverHung = () => false;

describe('listExpiredHungSuspectTasks (issue #1935)', () => {
  it('selects a hungSuspect task silent past the TTL with no PR hold', () => {
    const stale = hungTask({ id: 'stale' });
    const expired = listExpiredHungSuspectTasks([stale], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['stale']);
    expect(expired[0].silentForMs).toBe(TTL_MS + 60_000);
  });

  it('exempts an aged hungSuspect task that holds an open PR', () => {
    const stranded = hungTask({ id: 'stranded-pr' });
    const expired = listExpiredHungSuspectTasks([stranded], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      isHoldingOpenPr: () => true,
    });
    expect(expired).toEqual([]);
  });

  it('does not select a hungSuspect task younger than the TTL', () => {
    const fresh = hungTask({ id: 'fresh' });
    const expired = listExpiredHungSuspectTasks([fresh], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS - 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('does not select a task that is not classified hungSuspect', () => {
    const working = hungTask({ id: 'working' });
    const expired = listExpiredHungSuspectTasks([working], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: neverHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('does not reclaim needs_input even when silence + hungSuspect (human-gated stall)', () => {
    const waiting = hungTask({ id: 'waiting' });
    const expired = listExpiredHungSuspectTasks([waiting], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      getQueuedAnomalyType: () => 'needs_input',
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('does not reclaim permission_blocked even when silence + hungSuspect', () => {
    const blocked = hungTask({ id: 'blocked' });
    const expired = listExpiredHungSuspectTasks([blocked], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      getQueuedAnomalyType: () => 'permission_blocked',
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('does not reclaim provider_paused tasks (#1667 hold-for-resume)', () => {
    const paused = hungTask({ id: 'paused' });
    const expired = listExpiredHungSuspectTasks([paused], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      isProviderPaused: () => true,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('reclaims when queued anomaly is stale_agent (true silent death)', () => {
    const stale = hungTask({ id: 'stale-agent' });
    const expired = listExpiredHungSuspectTasks([stale], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      getQueuedAnomalyType: () => 'stale_agent',
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['stale-agent']);
  });

  it('does not select finishedAwaitingAck (completion_ready) — that path has its own reclaim', () => {
    const faa = hungTask({
      id: 'faa',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - 10 * TTL_MS).toISOString(),
      },
    });
    const expired = listExpiredHungSuspectTasks([faa], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('exempts every candidate when isHoldingOpenPr is not wired (fail-safe)', () => {
    const stale = hungTask({ id: 'no-predicate' });
    const expired = listExpiredHungSuspectTasks([stale], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
    });
    expect(expired).toEqual([]);
  });

  it('exempts when PR-hold status is unknown (undefined)', () => {
    const stale = hungTask({ id: 'unknown-pr' });
    const expired = listExpiredHungSuspectTasks([stale], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      isHoldingOpenPr: () => undefined,
    });
    expect(expired).toEqual([]);
  });

  it('skips a task with no liveness evidence (never invent silence-since-epoch)', () => {
    const noState = hungTask({ id: 'no-liveness' });
    const expired = listExpiredHungSuspectTasks([noState], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => undefined,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('skips all-zero liveness timestamps', () => {
    const zeros = hungTask({ id: 'zeros' });
    const expired = listExpiredHungSuspectTasks([zeros], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => ({ lastHookEventAt: 0, lastPaneChangeAt: 0, lastTokenActivityAt: 0 }),
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('ignores statuses other than inProgress', () => {
    const completed = hungTask({ id: 'completed', status: 'completed' });
    const cancelled = hungTask({ id: 'cancelled', status: 'cancelled' });
    const expired = listExpiredHungSuspectTasks([completed, cancelled], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('boundary: exactly at the TTL reclaims (inclusive)', () => {
    const boundary = hungTask({ id: 'boundary' });
    const justUnder = hungTask({ id: 'under' });
    const liveness = new Map<string, HungTaskLivenessEvidence>([
      ['boundary', silentFor(TTL_MS)],
      ['under', silentFor(TTL_MS - 1)],
    ]);
    const expired = listExpiredHungSuspectTasks([boundary, justUnder], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: (t) => liveness.get(t.id),
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['boundary']);
  });

  it('returns longest-silent first (oldest-first by silence age)', () => {
    const older = hungTask({ id: 'older' });
    const newer = hungTask({ id: 'newer' });
    const liveness = new Map<string, HungTaskLivenessEvidence>([
      ['older', silentFor(3 * TTL_MS)],
      ['newer', silentFor(2 * TTL_MS)],
    ]);
    const expired = listExpiredHungSuspectTasks([newer, older], {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: (t) => liveness.get(t.id),
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['older', 'newer']);
  });

  it('with 7 synthetic hungSuspect fixtures, selects all past TTL', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => hungTask({ id: `h${i}` }));
    const expired = listExpiredHungSuspectTasks(tasks, {
      now: NOW,
      ttlMs: TTL_MS,
      isHungSuspect: alwaysHung,
      getLiveness: () => silentFor(TTL_MS + 5_000),
      isHoldingOpenPr: () => false,
    });
    expect(expired).toHaveLength(7);
    expect(expired.map((e) => e.task.id).sort()).toEqual(
      Array.from({ length: 7 }, (_, i) => `h${i}`).sort(),
    );
  });

  it('defaults the TTL to 25 minutes, hard-capped constant at 60 minutes', () => {
    expect(DEFAULT_HUNG_SUSPECT_TTL_MS).toBe(25 * 60_000);
    expect(MAX_HUNG_SUSPECT_TTL_MS).toBe(60 * 60_000);
    const justUnderDefault = hungTask({ id: 'under-default' });
    const overDefault = hungTask({ id: 'over-default' });
    const liveness = new Map<string, HungTaskLivenessEvidence>([
      ['under-default', silentFor(DEFAULT_HUNG_SUSPECT_TTL_MS - 1)],
      ['over-default', silentFor(DEFAULT_HUNG_SUSPECT_TTL_MS)],
    ]);
    const expired = listExpiredHungSuspectTasks([justUnderDefault, overDefault], {
      now: NOW,
      isHungSuspect: alwaysHung,
      getLiveness: (t) => liveness.get(t.id),
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['over-default']);
  });
});
