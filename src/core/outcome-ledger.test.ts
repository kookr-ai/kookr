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
});

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
