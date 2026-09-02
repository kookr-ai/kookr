import { describe, expect, test } from 'vitest';
import { buildOutcomeLedger } from './outcome-ledger.js';
import type { Task } from './tasks.js';
import type { TokenUsage } from './usage-types.js';
import { aSession, aTask } from './__fixtures__/task-builders.js';

const NOW = new Date('2026-06-20T12:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;

function ledgerTask(overrides: Partial<Task> & { id: string }): Task {
  const createdAt = overrides.createdAt ?? new Date(NOW - HOUR);
  const updatedAt = overrides.updatedAt ?? new Date(toMs(createdAt) + 10 * 60 * 1000);
  return aTask({
    id: overrides.id,
    prompt: overrides.prompt ?? `Task ${overrides.id}`,
    cwd: overrides.cwd ?? '/repo',
    agentType: overrides.agentType ?? 'claude-code',
    status: overrides.status ?? 'completed',
    sessions: overrides.sessions ?? [aSession({
      tmuxSession: `session-${overrides.id}`,
      agentType: overrides.agentType ?? 'claude-code',
      cwd: '/repo',
      createdAt: new Date(toMs(createdAt)),
    })],
    createdAt,
    updatedAt,
    finishedAt: overrides.finishedAt ?? updatedAt,
    completionDigest: overrides.completionDigest,
    completionFeedback: overrides.completionFeedback,
    tokenUsage: overrides.tokenUsage,
    ...overrides,
  });
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 25,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    costUsd: overrides.costUsd ?? 0.12,
  };
}

function verifiedDigest() {
  return {
    bullets: ['Implemented requested change'],
    filesChanged: ['src/file.ts'],
    testSummary: 'Tests passed',
    verificationCommands: ['pnpm test'],
  };
}

function ledger(tasks: Task[], liveUsage?: Map<string, TokenUsage>) {
  return buildOutcomeLedger({
    tasks,
    liveUsage,
    window: '7d',
    windowStartMs: NOW - 7 * 24 * HOUR,
    windowEndMs: NOW,
  });
}

describe('buildOutcomeLedger', () => {
  test('summarizes clean completed tasks as ready by agent', () => {
    const tasks = [
      ledgerTask({
        id: 'claude-1',
        agentType: 'claude-code',
        tokenUsage: usage({ costUsd: 0.20, inputTokens: 200, outputTokens: 40 }),
        completionDigest: verifiedDigest(),
        completionFeedback: { rating: 'up' },
        finishedAt: new Date(NOW - HOUR + 10 * 60 * 1000),
      }),
      ledgerTask({
        id: 'codex-1',
        agentType: 'codex-cli',
        tokenUsage: usage({ costUsd: 0.30, inputTokens: 300, outputTokens: 60 }),
        completionDigest: verifiedDigest(),
        completionFeedback: { rating: 'down' },
        finishedAt: new Date(NOW - HOUR + 20 * 60 * 1000),
      }),
    ];
    const response = ledger(tasks);

    expect(response.readiness).toBe('ready');
    expect(response.summary).toMatchObject({
      taskCount: 2,
      completedTaskCount: 2,
      completionRate: 1,
      totalKnownCostUsd: 0.5,
      totalInputTokens: 500,
      totalOutputTokens: 100,
      thumbsUp: 1,
      thumbsDown: 1,
      thumbsUpRate: 0.5,
    });
    expect(response.quality.costCoverage).toBe(1);
    expect(response.quality.verificationCoverage).toBe(1);
    expect(response.byAgent).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentType: 'claude-code', taskCount: 1, completionRate: 1, totalKnownCostUsd: 0.20 }),
      expect.objectContaining({ agentType: 'codex-cli', taskCount: 1, completionRate: 1, totalKnownCostUsd: 0.30 }),
    ]));
  });

  test('keeps missing cost distinct from zero cost', () => {
    const missing = ledgerTask({ id: 'missing-cost' });
    const zero = ledgerTask({ id: 'zero-cost', tokenUsage: usage({ costUsd: 0 }) });
    const response = ledger([missing, zero]);

    expect(response.quality.missingCostTasks).toBe(1);
    expect(response.quality.zeroCostTasks).toBe(1);
    expect(response.tasks.find((row) => row.taskId === 'missing-cost')?.flags).toContain('missing_cost');
    expect(response.tasks.find((row) => row.taskId === 'zero-cost')?.flags).toContain('zero_cost');
    expect(response.findings.some((finding) => finding.message.includes('Unknown is kept separate from zero'))).toBe(false);
    expect(response.notes.some((note) => note.includes('Unknown is kept separate from zero'))).toBe(true);
  });

  test('blocks conclusions when terminal task timestamps are invalid', () => {
    const invalid = ledgerTask({
      id: 'invalid',
      createdAt: new Date('2026-06-20T12:00:00.000Z'),
      updatedAt: new Date('2026-06-20T11:00:00.000Z'),
      finishedAt: new Date('2026-06-20T11:00:00.000Z'),
      tokenUsage: usage(),
    });
    const response = ledger([invalid]);

    expect(response.readiness).toBe('blocked');
    expect(response.quality.invalidTimestampTasks).toBe(1);
    expect(response.findings[0]).toMatchObject({
      severity: 'critical',
      taskId: 'invalid',
      metric: 'duration',
    });
  });

  test('flags extreme duration before trusting duration conclusions', () => {
    const tasks = [
      ledgerTask({ id: 'a', tokenUsage: usage(), completionDigest: verifiedDigest(), finishedAt: new Date(NOW - HOUR + 5 * 60 * 1000) }),
      ledgerTask({ id: 'b', tokenUsage: usage(), completionDigest: verifiedDigest(), finishedAt: new Date(NOW - HOUR + 6 * 60 * 1000) }),
      ledgerTask({ id: 'c', tokenUsage: usage(), completionDigest: verifiedDigest(), finishedAt: new Date(NOW - HOUR + 7 * 60 * 1000) }),
      ledgerTask({ id: 'extreme', tokenUsage: usage(), completionDigest: verifiedDigest(), finishedAt: new Date(NOW - HOUR + 30 * HOUR) }),
    ];
    const response = ledger(tasks);

    expect(response.readiness).toBe('caution');
    expect(response.findings).toContainEqual(expect.objectContaining({
      kind: 'duration_extreme',
      taskId: 'extreme',
      severity: 'review',
    }));
  });

  test('uses current interaction log events when available', () => {
    const source = ledgerTask({ id: 'source', tokenUsage: usage() });
    const response = buildOutcomeLedger({
      tasks: [source],
      window: '7d',
      windowStartMs: NOW - 7 * 24 * HOUR,
      windowEndMs: NOW,
      interactionEvents: [
        { type: 'user_input', agentId: 'session-source', content: 'did tests pass?', timestamp: new Date(NOW).toISOString() },
        { type: 'finding_skipped', agentId: 'session-source', anomalyType: 'needs_input', timestamp: new Date(NOW).toISOString() },
      ],
    });

    expect(response.tasks[0].interventionCount).toBe(2);
    expect(response.quality.interventionCoverage).toBe(1);
  });

  test('defaults to every project and echoes the all scope', () => {
    const tasks = [
      ledgerTask({ id: 'assigned-a', projectId: 'alpha', tokenUsage: usage() }),
      ledgerTask({ id: 'unassigned-a', tokenUsage: usage() }),
    ];
    const response = ledger(tasks);

    expect(response.scope).toEqual({ kind: 'all' });
    expect(response.summary.taskCount).toBe(2);
  });

  test('assigned scope filters to one project before aggregation', () => {
    const tasks = [
      ledgerTask({ id: 'alpha-1', projectId: 'alpha', tokenUsage: usage({ costUsd: 0.10 }) }),
      ledgerTask({ id: 'alpha-2', projectId: 'alpha', tokenUsage: usage({ costUsd: 0.20 }) }),
      ledgerTask({ id: 'beta-1', projectId: 'beta', tokenUsage: usage({ costUsd: 5 }) }),
      ledgerTask({ id: 'none-1', tokenUsage: usage({ costUsd: 9 }) }),
    ];
    const response = buildOutcomeLedger({
      tasks,
      window: '7d',
      windowStartMs: NOW - 7 * 24 * HOUR,
      windowEndMs: NOW,
      projectScope: { kind: 'assigned', projectId: 'alpha' },
    });

    expect(response.scope).toEqual({ kind: 'assigned', projectId: 'alpha' });
    expect(response.summary.taskCount).toBe(2);
    // Cost aggregates only over the scoped population — beta/unassigned excluded.
    expect(response.summary.totalKnownCostUsd).toBeCloseTo(0.30, 10);
    expect(response.tasks.map((row) => row.taskId).sort()).toEqual(['alpha-1', 'alpha-2']);
    expect(response.tasks.every((row) => row.projectId === 'alpha')).toBe(true);
  });

  test('unassigned scope keeps only tasks with no project', () => {
    const tasks = [
      ledgerTask({ id: 'alpha-1', projectId: 'alpha', tokenUsage: usage() }),
      ledgerTask({ id: 'none-1', tokenUsage: usage() }),
      ledgerTask({ id: 'none-2', tokenUsage: usage() }),
    ];
    const response = buildOutcomeLedger({
      tasks,
      window: '7d',
      windowStartMs: NOW - 7 * 24 * HOUR,
      windowEndMs: NOW,
      projectScope: { kind: 'unassigned' },
    });

    expect(response.scope).toEqual({ kind: 'unassigned' });
    expect(response.summary.taskCount).toBe(2);
    expect(response.tasks.every((row) => row.projectId === null)).toBe(true);
  });

  test('unknown project ID yields a valid empty scoreboard, not a broadened query', () => {
    const tasks = [
      ledgerTask({ id: 'alpha-1', projectId: 'alpha', tokenUsage: usage() }),
      ledgerTask({ id: 'none-1', tokenUsage: usage() }),
    ];
    const response = buildOutcomeLedger({
      tasks,
      window: '7d',
      windowStartMs: NOW - 7 * 24 * HOUR,
      windowEndMs: NOW,
      projectScope: { kind: 'assigned', projectId: 'does-not-exist' },
    });

    expect(response.summary.taskCount).toBe(0);
    expect(response.tasks).toEqual([]);
    expect(response.byAgent).toEqual([]);
    // An empty window is blocked, not ready — the panel should not read a
    // confident verdict from zero rows.
    expect(response.readiness).toBe('blocked');
  });

  test('treats a project ID with URL-significant characters as an opaque literal', () => {
    const literal = 'org/repo?x=1&y=2';
    const tasks = [
      ledgerTask({ id: 'match', projectId: literal, tokenUsage: usage() }),
      ledgerTask({ id: 'other', projectId: 'org/repo', tokenUsage: usage() }),
    ];
    const response = buildOutcomeLedger({
      tasks,
      window: '7d',
      windowStartMs: NOW - 7 * 24 * HOUR,
      windowEndMs: NOW,
      projectScope: { kind: 'assigned', projectId: literal },
    });

    expect(response.summary.taskCount).toBe(1);
    expect(response.tasks[0].taskId).toBe('match');
  });

  test('redacts historical labels and leaves historical interventions unknown', () => {
    const live = ledgerTask({
      id: 'live-task',
      prompt: 'Visible live prompt',
      tokenUsage: usage(),
      completionDigest: verifiedDigest(),
    });
    const historical = ledgerTask({
      id: 'historical-secret-task',
      prompt: 'Secret swept prompt',
      tokenUsage: usage(),
      completionDigest: verifiedDigest(),
    });
    const response = buildOutcomeLedger({
      tasks: [live, historical],
      window: '7d',
      windowStartMs: NOW - 7 * 24 * HOUR,
      windowEndMs: NOW,
      liveTaskIds: new Set([live.id]),
      interactionTaskIds: new Set([live.id]),
      interactionEvents: [
        { type: 'user_input', agentId: 'session-live-task', content: 'check live task', timestamp: new Date(NOW).toISOString() },
      ],
    });

    expect(response.tasks.find((row) => row.taskId === live.id)?.label).toBe('Visible live prompt');
    const historicalRow = response.tasks.find((row) => row.taskId === historical.id);
    expect(historicalRow?.label).toBe('Historical task historic');
    expect(historicalRow?.label).not.toContain('Secret swept prompt');
    expect(historicalRow?.interventionCount).toBeNull();
    expect(historicalRow?.flags).toContain('missing_intervention_data');
    expect(response.quality.interventionCoverage).toBe(0.5);
  });

  test('projects a launch-source mix across manual, scheduled, parent, and legacy tasks', () => {
    const tasks = [
      ledgerTask({ id: 'manual-1', provenance: { kind: 'manual', sourceId: 'ui' } }),
      ledgerTask({ id: 'manual-2', provenance: { kind: 'manual', sourceId: 'cli' } }),
      ledgerTask({ id: 'scheduled-1', provenance: { kind: 'schedule', sourceId: 'sched-a' } }),
      ledgerTask({ id: 'parent-1', provenance: { kind: 'parent', sourceId: 'root-task' } }),
      ledgerTask({ id: 'explicit-unknown', provenance: { kind: 'unknown' } }),
      // No `provenance` at all: a legacy task persisted before the field existed.
      ledgerTask({ id: 'legacy-1' }),
    ];
    const response = ledger(tasks);

    expect(response.launchSourceMix.total).toBe(6);
    expect(response.launchSourceMix.counts).toEqual({
      manual: 2,
      scheduled: 1,
      parent: 1,
      unknown: 2,
    });
    expect(response.launchSourceMix.shares).toEqual({
      manual: 2 / 6,
      scheduled: 1 / 6,
      parent: 1 / 6,
      unknown: 2 / 6,
    });
    // Per-row provenance is normalized onto every task row too — one assertion
    // per `normalizeLaunchSource` arm so no bucket is only checked in aggregate.
    const sourceOf = (id: string) => response.tasks.find((row) => row.taskId === id)?.launchSource;
    expect(sourceOf('manual-1')).toBe('manual');
    expect(sourceOf('scheduled-1')).toBe('scheduled');
    expect(sourceOf('parent-1')).toBe('parent');
    expect(sourceOf('explicit-unknown')).toBe('unknown');
    expect(sourceOf('legacy-1')).toBe('unknown');
  });

  test('launch-source mix reports every bucket as zero with null shares for an empty window', () => {
    const response = ledger([]);
    expect(response.launchSourceMix.total).toBe(0);
    expect(response.launchSourceMix.counts).toEqual({ manual: 0, scheduled: 0, parent: 0, unknown: 0 });
    expect(response.launchSourceMix.shares).toBeNull();
  });

  test('launch-source mix does not disturb existing completion, cost, verification, or feedback metrics', () => {
    const base = {
      tokenUsage: usage({ costUsd: 0.2 }),
      completionDigest: verifiedDigest(),
      completionFeedback: { rating: 'up' as const },
    };
    const withoutProvenance = ledger([
      ledgerTask({ id: 'a', ...base }),
      ledgerTask({ id: 'b', ...base }),
    ]);
    const withProvenance = ledger([
      ledgerTask({ id: 'a', ...base, provenance: { kind: 'schedule', sourceId: 's' } }),
      ledgerTask({ id: 'b', ...base, provenance: { kind: 'manual', sourceId: 'ui' } }),
    ]);
    // Stamping provenance changes only the launch-source projection, never the
    // completion/cost/verification/feedback rollups.
    expect(withProvenance.summary).toEqual(withoutProvenance.summary);
    expect(withProvenance.quality).toEqual(withoutProvenance.quality);
    expect(withProvenance.readiness).toBe(withoutProvenance.readiness);
  });

  describe('previous-window comparison (issue #2784)', () => {
    const DAY = 24 * HOUR;

    test('reports equal-duration deltas when the previous window has tasks', () => {
      const tasks = [
        // Current window [NOW-7d, NOW]: 2 completed, both verified, both 👍.
        ledgerTask({ id: 'cur-a', status: 'completed', createdAt: new Date(NOW - DAY), completionDigest: verifiedDigest(), completionFeedback: { rating: 'up' }, tokenUsage: usage() }),
        ledgerTask({ id: 'cur-b', status: 'completed', createdAt: new Date(NOW - 2 * DAY), completionDigest: verifiedDigest(), completionFeedback: { rating: 'up' }, tokenUsage: usage() }),
        // Previous window [NOW-14d, NOW-7d): 1 completed (verified, 👍), 1 terminated.
        ledgerTask({ id: 'prev-a', status: 'completed', createdAt: new Date(NOW - 8 * DAY), completionDigest: verifiedDigest(), completionFeedback: { rating: 'up' }, tokenUsage: usage() }),
        ledgerTask({ id: 'prev-b', status: 'terminated', createdAt: new Date(NOW - 9 * DAY), finishedAt: new Date(NOW - 9 * DAY + 10 * 60 * 1000), tokenUsage: usage() }),
      ];
      const response = ledger(tasks);

      // Previous-window tasks never leak into the current-window rollups.
      expect(response.summary.taskCount).toBe(2);
      expect(response.comparison.available).toBe(true);
      if (!response.comparison.available) throw new Error('expected comparison to be available');
      expect(response.comparison.previousTaskCount).toBe(2);
      // completion: current 2/2 = 1, previous 1/2 = 0.5.
      expect(response.comparison.completionRate).toEqual({ current: 1, previous: 0.5, delta: 0.5 });
      // verification (completed-only) and feedback are unchanged across windows.
      expect(response.comparison.verificationCoverage).toEqual({ current: 1, previous: 1, delta: 0 });
      expect(response.comparison.thumbsUpRate).toEqual({ current: 1, previous: 1, delta: 0 });
      expect(response.comparison.costCoverage).toEqual({ current: 1, previous: 1, delta: 0 });
      expect(response.comparison.previousWindow.start).toBe(new Date(NOW - 14 * DAY).toISOString());
      expect(response.comparison.previousWindow.end).toBe(new Date(NOW - 7 * DAY).toISOString());
    });

    test('the all-time window has no bounded baseline to compare against', () => {
      const response = buildOutcomeLedger({
        tasks: [ledgerTask({ id: 'x' })],
        window: 'all',
        windowStartMs: 0,
        windowEndMs: NOW,
      });
      expect(response.comparison).toEqual({ available: false, reason: 'all_time_window' });
    });

    test('an empty previous window is unavailable rather than a zero change', () => {
      const response = ledger([ledgerTask({ id: 'cur', createdAt: new Date(NOW - HOUR) })]);
      expect(response.comparison).toEqual({ available: false, reason: 'no_previous_data' });
    });

    test('a metric unknown on either side yields a null delta, not a zero', () => {
      const tasks = [
        ledgerTask({ id: 'cur', status: 'completed', createdAt: new Date(NOW - DAY), tokenUsage: usage() }),
        // Previous window holds only a non-terminal task: no completion rate exists.
        ledgerTask({ id: 'prev-active', status: 'inProgress', createdAt: new Date(NOW - 8 * DAY) }),
      ];
      const response = ledger(tasks);

      expect(response.comparison.available).toBe(true);
      if (!response.comparison.available) throw new Error('expected comparison to be available');
      expect(response.comparison.completionRate.previous).toBeNull();
      expect(response.comparison.completionRate.delta).toBeNull();
    });

    test('a task on the shared window boundary counts in the current window only', () => {
      const boundary = new Date(NOW - 7 * DAY);
      const response = ledger([ledgerTask({ id: 'boundary', createdAt: boundary })]);
      // The task sits exactly on windowStart: current window is inclusive there,
      // so it is a current task and the previous window is empty.
      expect(response.summary.taskCount).toBe(1);
      expect(response.comparison).toEqual({ available: false, reason: 'no_previous_data' });
    });
  });
});

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
