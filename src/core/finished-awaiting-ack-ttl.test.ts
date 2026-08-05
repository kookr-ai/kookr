import { describe, it, expect } from 'vitest';
import {
  listExpiredFinishedAwaitingAckTasks,
  listMetaFinishedAwaitingAckAutoCompleteTasks,
  isMetaFaaAutoCompletePlaybook,
  isMetaFaaAutoCompleteEligible,
  taskHasLiveTurn,
  DEFAULT_FINISHED_AWAITING_ACK_TTL_MS,
  DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS,
  MAX_FINISHED_AWAITING_ACK_TTL_MS,
} from './finished-awaiting-ack-ttl.js';
import type { Task } from './task-read-model.js';
import type { SessionInfo } from './session-read-model.js';

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

describe('meta FAA auto-complete eligibility (issue #2070)', () => {
  it('matches allowlisted meta/playbook ids and name-only fallback', () => {
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'cross-repo-orchestrator.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'parallel-issue-batch.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'lucy-workflow-incident-sentinel.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'lucy-workflow-reflection.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'repository-idea-scout.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'pr-merge-rebase-watchdog.md' })).toBe(true);
    // Name fallback only when playbookId is absent.
    expect(isMetaFaaAutoCompletePlaybook({ name: 'Lucy Progress Watchdog' })).toBe(true);
    // Implementers must NOT match.
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'implement-github-issue.md' })).toBe(false);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'oss-bug-fix.md' })).toBe(false);
  });

  it('does not relax PR fail-safe when an implementer name contains a meta substring', () => {
    // Regression for reviewer B1: playbookId wins; name is ignored when set.
    expect(
      isMetaFaaAutoCompletePlaybook({
        playbookId: 'implement-github-issue.md',
        name: 'Fix orchestrator race in sentinel reflection',
      }),
    ).toBe(false);
    expect(
      isMetaFaaAutoCompleteEligible({
        playbookId: 'implement-github-issue.md',
        name: 'Fix orchestrator race in sentinel reflection',
        pendingSignal: {
          kind: 'completion_ready',
          raisedAt: NOW.toISOString(),
          source: 'http',
        },
      }),
    ).toBe(false);
  });

  it('does not treat bare source=http as meta-eligible without an allowlist match', () => {
    expect(
      isMetaFaaAutoCompleteEligible({
        pendingSignal: {
          kind: 'completion_ready',
          raisedAt: NOW.toISOString(),
          source: 'http',
        },
      }),
    ).toBe(false);
  });

  it('taskHasLiveTurn detects running / waiting_for_input / blocked sessions', () => {
    const running: SessionInfo = {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: NOW,
      lastTurnState: 'running',
    };
    const waiting: SessionInfo = {
      tmuxSession: 's3',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: NOW,
      lastTurnState: 'waiting_for_input',
    };
    const blocked: SessionInfo = {
      tmuxSession: 's4',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: NOW,
      lastTurnState: 'blocked',
    };
    const idle: SessionInfo = {
      tmuxSession: 's2',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: NOW,
      lastTurnState: 'completed_turn',
    };
    expect(taskHasLiveTurn({ sessions: [running] })).toBe(true);
    expect(taskHasLiveTurn({ sessions: [waiting] })).toBe(true);
    expect(taskHasLiveTurn({ sessions: [blocked] })).toBe(true);
    expect(taskHasLiveTurn({ sessions: [idle] })).toBe(false);
    expect(
      taskHasLiveTurn({
        sessions: [{ ...running, lastStatus: 'completed' }],
      }),
    ).toBe(false);
  });
});

describe('listMetaFinishedAwaitingAckAutoCompleteTasks (issue #2070)', () => {
  const ttlMs = DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS;

  it('selects an aged meta playbook FAA task even when PR-hold is unknown (relaxed fail-safe)', () => {
    const stale = faaTask({
      id: 'orchestrator',
      playbookId: 'cross-repo-orchestrator.md',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
        source: 'http',
      },
      sessions: [
        {
          tmuxSession: 's',
          agentType: 'grok-build',
          cwd: '/tmp',
          createdAt: new Date(NOW.getTime() - 30 * 60_000),
          lastTurnState: 'completed_turn',
        } as SessionInfo,
      ],
    });
    // Strict path would skip (undefined ≠ false).
    expect(
      listExpiredFinishedAwaitingAckTasks([stale], {
        now: NOW,
        ttlMs,
        isHoldingOpenPr: () => undefined,
      }),
    ).toEqual([]);

    const selected = listMetaFinishedAwaitingAckAutoCompleteTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => undefined,
    });
    expect(selected.map((e) => e.task.id)).toEqual(['orchestrator']);
  });

  it('still blocks meta tasks with a confirmed-open PR', () => {
    const stranded = faaTask({
      id: 'meta-with-pr',
      playbookId: 'parallel-issue-batch.md',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
        source: 'http',
      },
    });
    const selected = listMetaFinishedAwaitingAckAutoCompleteTasks([stranded], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => true,
    });
    expect(selected).toEqual([]);
  });

  it('still selects a live-turn task at pure select time (TOCTOU defer is the sweep\'s job)', () => {
    const live = faaTask({
      id: 'live-turn',
      playbookId: 'lucy-workflow-reflection.md',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
        source: 'http',
      },
      sessions: [
        {
          tmuxSession: 's',
          agentType: 'claude-code',
          cwd: '/tmp',
          createdAt: new Date(NOW.getTime() - 30 * 60_000),
          lastTurnState: 'running',
        } as SessionInfo,
      ],
    });
    // Pure selector leaves live-turn veto to the sweep so deferrals are countable.
    const selected = listMetaFinishedAwaitingAckAutoCompleteTasks([live], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => undefined,
    });
    expect(selected.map((e) => e.task.id)).toEqual(['live-turn']);
    expect(taskHasLiveTurn(live)).toBe(true);
  });

  it('does not select an implementer playbook under the relaxed path (even with clear PR)', () => {
    const implementer = faaTask({
      id: 'implementer',
      playbookId: 'implement-github-issue.md',
      name: 'Fix orchestrator race',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
        source: 'http',
      },
    });
    // Not allowlisted — stays on the strict #1884 path only.
    const selected = listMetaFinishedAwaitingAckAutoCompleteTasks([implementer], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(selected).toEqual([]);
  });

  it('does not select younger than the meta TTL', () => {
    const fresh = faaTask({
      id: 'fresh-meta',
      playbookId: 'cross-repo-orchestrator.md',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs + 60_000).toISOString(),
        source: 'http',
      },
    });
    expect(
      listMetaFinishedAwaitingAckAutoCompleteTasks([fresh], {
        now: NOW,
        ttlMs,
        isHoldingOpenPr: () => undefined,
      }),
    ).toEqual([]);
  });
});
