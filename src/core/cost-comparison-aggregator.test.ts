import { describe, test, expect } from 'vitest';
import { aggregate, type AggregatorInput } from './cost-comparison-aggregator.js';
import type { Task, TaskStatus } from './tasks.js';
import type { TokenUsage } from './types.js';
import type { Playbook } from '../shared/contracts/playbook.js';
import type {
  BoundTaskTokens,
  CodexRolloutMeta,
  DiscoveryOutcome,
} from '../adapters/codex-rollout-scanner.js';
import type { CostAgent } from '../shared/contracts/cost-comparison.js';

const NOW = new Date('2026-05-08T12:00:00.000Z').getTime();
const ONE_DAY_MS = 86_400_000;

function task(overrides: Partial<Task> & { id: string; agentType: 'claude-code' | 'codex-cli' }): Task {
  const created = overrides.createdAt ?? new Date(NOW - ONE_DAY_MS);
  const updated = overrides.updatedAt ?? new Date(created.getTime() + 60_000);
  return {
    id: overrides.id,
    name: overrides.name,
    prompt: overrides.prompt ?? '',
    cwd: overrides.cwd ?? '/repo',
    agentType: overrides.agentType,
    playbookId: overrides.playbookId,
    parentTaskId: overrides.parentTaskId,
    childTaskIds: overrides.childTaskIds,
    projectId: overrides.projectId,
    status: (overrides.status ?? 'completed') as TaskStatus,
    sessions: overrides.sessions ?? [],
    tokenUsage: overrides.tokenUsage,
    completionFeedback: overrides.completionFeedback,
    autonomy: overrides.autonomy ?? 'supervised',
    createdAt: created,
    updatedAt: updated,
  };
}

function tokenUsage(o: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: o.inputTokens ?? 0,
    outputTokens: o.outputTokens ?? 0,
    cacheReadTokens: o.cacheReadTokens ?? 0,
    cacheWriteTokens: o.cacheWriteTokens ?? 0,
    costUsd: o.costUsd ?? 0,
  };
}

function fakeRollout(id: string, model: string | null, cwd: string, totals?: { in?: number; out?: number; cached?: number }): CodexRolloutMeta {
  return {
    path: `/tmp/rollout-${id}.jsonl`,
    id,
    cwd,
    startedAt: new Date(NOW - ONE_DAY_MS),
    cliVersion: '0.125.0',
    forkedFromId: null,
    parentThreadId: null,
    agentNickname: null,
    model,
    totalUsage: totals ? {
      inputTokens: totals.in ?? 0,
      outputTokens: totals.out ?? 0,
      cachedInputTokens: totals.cached ?? 0,
      reasoningOutputTokens: 0,
    } : null,
    hasTerminalEvent: true,
    mtimeMs: NOW - 60_000,
    parseError: null,
  };
}

function boundOutcome(taskId: string, model: string | null, totals: { in: number; out: number; cached: number }): DiscoveryOutcome {
  const parent = fakeRollout(`parent-${taskId}`, model, '/repo', totals);
  const binding: BoundTaskTokens = {
    taskId, parent, subagents: [],
    totalInputTokens: totals.in,
    totalOutputTokens: totals.out,
    totalCachedInputTokens: totals.cached,
    model,
    hasTokenData: true,
    hasParseError: false,
  };
  return { kind: 'bound', binding };
}

function baseInput(overrides: Partial<AggregatorInput> = {}): AggregatorInput {
  return {
    tasks: [],
    windowStartMs: NOW - 7 * ONE_DAY_MS,
    windowEndMs: NOW,
    claudeUsage: new Map(),
    codexOutcomes: new Map(),
    playbooksById: new Map(),
    todayMs: NOW,
    scannedAt: new Date(NOW).toISOString(),
    scanDurationMs: 12,
    ...overrides,
  };
}

describe('aggregate — empty / boundary', () => {
  test('empty task list → empty perPlaybook + aggregate, no notes', () => {
    const r = aggregate(baseInput());
    expect(r.perPlaybook).toEqual([]);
    expect(r.aggregate).toEqual({});
    expect(r.perTask).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.scanDurationMs).toBe(12);
  });

  test('task created BEFORE window start is excluded', () => {
    const r = aggregate(baseInput({
      tasks: [task({ id: 't1', agentType: 'claude-code', createdAt: new Date(NOW - 8 * ONE_DAY_MS) })],
      claudeUsage: new Map([['t1', tokenUsage({ inputTokens: 1, costUsd: 0.5 })]]),
    }));
    expect(r.perTask).toHaveLength(0);
  });

  test('task created AFTER window end is excluded', () => {
    const r = aggregate(baseInput({
      tasks: [task({ id: 't2', agentType: 'claude-code', createdAt: new Date(NOW + ONE_DAY_MS) })],
      claudeUsage: new Map([['t2', tokenUsage({ inputTokens: 1, costUsd: 0.5 })]]),
    }));
    expect(r.perTask).toHaveLength(0);
  });

  test('task at exact window boundary (=== windowStartMs) is included', () => {
    const created = new Date(NOW - 7 * ONE_DAY_MS);
    const r = aggregate(baseInput({
      tasks: [task({ id: 't3', agentType: 'claude-code', createdAt: created })],
      claudeUsage: new Map([['t3', tokenUsage({ costUsd: 1 })]]),
    }));
    expect(r.perTask).toHaveLength(1);
  });
});

describe('aggregate — single-agent', () => {
  test('single Claude task: aggregate has only claude-code, perPlaybook bucketed by playbookId', () => {
    const r = aggregate(baseInput({
      tasks: [
        task({ id: 't1', agentType: 'claude-code', playbookId: 'pb-1', completionFeedback: { rating: 'up' } }),
        task({ id: 't2', agentType: 'claude-code', playbookId: 'pb-1', completionFeedback: { rating: 'down' } }),
      ],
      claudeUsage: new Map([
        ['t1', tokenUsage({ inputTokens: 1000, outputTokens: 500, costUsd: 1.0 })],
        ['t2', tokenUsage({ inputTokens: 2000, outputTokens: 1000, costUsd: 2.5 })],
      ]),
      playbooksById: new Map([['pb-1', { id: 'pb-1', name: 'Playbook 1' } as Playbook]]),
    }));
    expect(r.aggregate['claude-code']?.taskCount).toBe(2);
    expect(r.aggregate['claude-code']?.totalCostUsd).toBeCloseTo(3.5);
    expect(r.aggregate['codex-cli']).toBeUndefined();
    expect(r.perPlaybook).toHaveLength(1);
    expect(r.perPlaybook[0].playbookName).toBe('Playbook 1');
    expect(r.perPlaybook[0].perAgent['claude-code']?.thumbsUpRate).toBe(0.5);
  });

  test('Codex task with bound outcome contributes Codex tokens with cached subtracted before billing', () => {
    const t1 = task({ id: 'x1', agentType: 'codex-cli', completionFeedback: { rating: 'up' } });
    const r = aggregate(baseInput({
      tasks: [t1],
      codexOutcomes: new Map([['x1', boundOutcome('x1', 'gpt-5.3-codex', { in: 1_000_000, out: 100_000, cached: 800_000 })]]),
    }));
    expect(r.aggregate['codex-cli']?.taskCount).toBe(1);
    // billed input = 1M - 800K = 200K @ $1.75/MTok = $0.35
    // cached = 800K @ $0.175/MTok = $0.14
    // output = 100K @ $14/MTok = $1.40
    // total ≈ $1.89
    expect(r.aggregate['codex-cli']?.totalCostUsd).toBeCloseTo(0.35 + 0.14 + 1.40, 2);
  });
});

describe('aggregate — dataQuality propagation', () => {
  test('codex-rollout-not-found row is included with cost null, but does NOT contribute to aggregate cost', () => {
    const t = task({ id: 'nf', agentType: 'codex-cli' });
    const r = aggregate(baseInput({
      tasks: [t],
      codexOutcomes: new Map([['nf', { kind: 'not-found', reason: 'no-candidates', candidateCount: 0 }]]),
    }));
    expect(r.perTask[0].dataQuality).toBe('codex-rollout-not-found');
    expect(r.perTask[0].estimatedCostUsd).toBeNull();
    expect(r.aggregate['codex-cli']?.taskCount).toBe(1);
    expect(r.aggregate['codex-cli']?.totalCostUsd).toBe(0);                // unpriced row excluded
  });

  test('codex-rollout-abandoned dataQuality and exclusion from aggregate', () => {
    const t = task({ id: 'aband', agentType: 'codex-cli' });
    const r = aggregate(baseInput({
      tasks: [t],
      codexOutcomes: new Map([['aband', { kind: 'abandoned', mostRecentRolloutMtimeMs: NOW - ONE_DAY_MS }]]),
    }));
    expect(r.perTask[0].dataQuality).toBe('codex-rollout-abandoned');
    expect(r.aggregate['codex-cli']?.totalCostUsd).toBe(0);
  });

  test('codex-parse-error: binding has hasParseError → row dataQuality is codex-parse-error', () => {
    const t = task({ id: 'pe', agentType: 'codex-cli' });
    const parent = fakeRollout('parent', 'gpt-5.3-codex', '/repo', undefined);
    parent.parseError = 'broken';
    const binding: BoundTaskTokens = {
      taskId: 'pe', parent, subagents: [],
      totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0,
      model: 'gpt-5.3-codex', hasTokenData: false, hasParseError: true,
    };
    const r = aggregate(baseInput({
      tasks: [t],
      codexOutcomes: new Map([['pe', { kind: 'bound', binding }]]),
    }));
    expect(r.perTask[0].dataQuality).toBe('codex-parse-error');
  });

  test('codex-no-tokens: binding has no token data', () => {
    const t = task({ id: 'nt', agentType: 'codex-cli' });
    const parent = fakeRollout('parent', 'gpt-5.3-codex', '/repo', undefined);
    const binding: BoundTaskTokens = {
      taskId: 'nt', parent, subagents: [],
      totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0,
      model: 'gpt-5.3-codex', hasTokenData: false, hasParseError: false,
    };
    const r = aggregate(baseInput({
      tasks: [t],
      codexOutcomes: new Map([['nt', { kind: 'bound', binding }]]),
    }));
    expect(r.perTask[0].dataQuality).toBe('codex-no-tokens');
  });

  test('unknown-pricing: bound row with model not in pricing-tables → cost null, dataQuality unknown-pricing', () => {
    const t = task({ id: 'up', agentType: 'codex-cli' });
    const r = aggregate(baseInput({
      tasks: [t],
      codexOutcomes: new Map([['up', boundOutcome('up', 'gpt-7-future', { in: 1000, out: 500, cached: 0 })]]),
    }));
    expect(r.perTask[0].dataQuality).toBe('unknown-pricing');
    expect(r.perTask[0].estimatedCostUsd).toBeNull();
    expect(r.notes.some(n => n.message.includes('Unknown pricing for model'))).toBe(true);
  });
});

describe('aggregate — per-playbook bucketing', () => {
  test('null playbookId tasks are bucketed under "<no-playbook>"', () => {
    const r = aggregate(baseInput({
      tasks: [
        task({ id: 't1', agentType: 'claude-code' }),                 // no playbookId
        task({ id: 't2', agentType: 'codex-cli' }),
      ],
      claudeUsage: new Map([['t1', tokenUsage({ costUsd: 1 })]]),
      codexOutcomes: new Map([['t2', boundOutcome('t2', 'gpt-5.3-codex', { in: 1000, out: 100, cached: 0 })]]),
    }));
    expect(r.perPlaybook).toHaveLength(1);
    expect(r.perPlaybook[0].playbookName).toBe('<no-playbook>');
    expect(r.perPlaybook[0].perAgent['claude-code']?.taskCount).toBe(1);
    expect(r.perPlaybook[0].perAgent['codex-cli']?.taskCount).toBe(1);
  });

  test('per-playbook table sorted alphabetically by playbookName', () => {
    const r = aggregate(baseInput({
      tasks: [
        task({ id: 'a', agentType: 'claude-code', playbookId: 'pb-z' }),
        task({ id: 'b', agentType: 'claude-code', playbookId: 'pb-a' }),
      ],
      claudeUsage: new Map([['a', tokenUsage({ costUsd: 1 })], ['b', tokenUsage({ costUsd: 1 })]]),
      playbooksById: new Map([
        ['pb-z', { id: 'pb-z', name: 'Zeta' } as Playbook],
        ['pb-a', { id: 'pb-a', name: 'Alpha' } as Playbook],
      ]),
    }));
    expect(r.perPlaybook.map(p => p.playbookName)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('aggregate — durations and percentiles', () => {
  test('p95 is interpolated linearly between adjacent samples', () => {
    const tasks: Task[] = [];
    const usage = new Map<string, TokenUsage>();
    for (let i = 0; i < 5; i++) {
      const created = new Date(NOW - ONE_DAY_MS);
      const updated = new Date(created.getTime() + (i + 1) * 1000);   // 1s, 2s, 3s, 4s, 5s
      tasks.push(task({ id: `t${i}`, agentType: 'claude-code', createdAt: created, updatedAt: updated }));
      usage.set(`t${i}`, tokenUsage({ costUsd: 1 }));
    }
    const r = aggregate(baseInput({ tasks, claudeUsage: usage }));
    const m = r.aggregate['claude-code']!;
    // sorted [1000, 2000, 3000, 4000, 5000]
    // median = 3000
    // p95 idx = (5-1)*0.95 = 3.8 → linear 4000 + 0.8*(5000-4000) = 4800
    // max = 5000
    expect(m.medianDurationMs).toBe(3000);
    expect(m.p95DurationMs).toBeCloseTo(4800);
    expect(m.maxDurationMs).toBe(5000);
  });
});

describe('aggregate — thumbsUpRate denominator', () => {
  test('denominator excludes tasks with no recorded thumb', () => {
    const tasks: Task[] = [
      task({ id: 'u1', agentType: 'claude-code', completionFeedback: { rating: 'up' } }),
      task({ id: 'u2', agentType: 'claude-code', completionFeedback: { rating: 'up' } }),
      task({ id: 'd1', agentType: 'claude-code', completionFeedback: { rating: 'down' } }),
      task({ id: 'n1', agentType: 'claude-code' }),                   // no feedback
      task({ id: 'n2', agentType: 'claude-code' }),
    ];
    const usage = new Map<string, TokenUsage>();
    for (const t of tasks) usage.set(t.id, tokenUsage({ costUsd: 1 }));
    const r = aggregate(baseInput({ tasks, claudeUsage: usage }));
    const m = r.aggregate['claude-code']!;
    expect(m.thumbsCount).toEqual({ up: 2, down: 1, none: 2 });
    // 2 up / (2 up + 1 down) = 2/3, NOT 2/5 — no-feedback tasks must not pull the rate down.
    expect(m.thumbsUpRate).toBeCloseTo(2 / 3);
  });

  test('thumbsUpRate is null when no feedback at all', () => {
    const r = aggregate(baseInput({
      tasks: [task({ id: 't', agentType: 'claude-code' })],
      claudeUsage: new Map([['t', tokenUsage({ costUsd: 1 })]]),
    }));
    expect(r.aggregate['claude-code']?.thumbsUpRate).toBeNull();
  });
});

describe('aggregate — notes priority order (R17)', () => {
  test('parse-error notes appear before unknown-pricing notes', () => {
    const taskParseErr = task({ id: 'pe', agentType: 'codex-cli' });
    const parent = fakeRollout('parent', 'gpt-5.3-codex', '/repo', undefined);
    parent.parseError = 'broken';
    const peBinding: BoundTaskTokens = {
      taskId: 'pe', parent, subagents: [],
      totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0,
      model: 'gpt-5.3-codex', hasTokenData: false, hasParseError: true,
    };
    const taskUnknown = task({ id: 'up', agentType: 'codex-cli' });
    const r = aggregate(baseInput({
      tasks: [taskParseErr, taskUnknown],
      codexOutcomes: new Map([
        ['pe', { kind: 'bound', binding: peBinding }],
        ['up', boundOutcome('up', 'gpt-7-future', { in: 1, out: 1, cached: 0 })],
      ]),
      codexStats: { rolloutCount: 2, parseErrorCount: 1, abandonedCount: 0, orphanRollouts: [] },
    }));
    const peIdx = r.notes.findIndex(n => n.message.includes('parse error'));
    const upIdx = r.notes.findIndex(n => n.message.includes('Unknown pricing'));
    expect(peIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(peIdx);
  });

  test('pricing-stale note fires when lastVerified > 90 days', () => {
    const r = aggregate(baseInput({
      tasks: [task({ id: 'codex-stale', agentType: 'codex-cli' })],
      codexOutcomes: new Map([['codex-stale', boundOutcome('codex-stale', 'gpt-5.3-codex', { in: 1000, out: 100, cached: 0 })]]),
      todayMs: new Date('2026-09-01T00:00:00Z').getTime(),               // ~ 116 days after 2026-05-08
    }));
    const stale = r.notes.find(n => n.message.includes('was last verified'));
    expect(stale).toBeDefined();
    expect(stale!.message).toContain('gpt-5.3-codex');
  });

  test('orphan-rollouts note fires only when codexHome was reachable', () => {
    const r = aggregate(baseInput({
      tasks: [],
      codexStats: {
        rolloutCount: 5, parseErrorCount: 0, abandonedCount: 0,
        orphanRollouts: [fakeRollout('orphan-1', 'gpt-5.3-codex', '/elsewhere')],
      },
    }));
    expect(r.notes.some(n => n.message.includes('not bound to any Kookr task'))).toBe(true);
  });

  test('codex-home-missing fires when there are codex tasks but the scanner returned 0 rollouts', () => {
    const r = aggregate(baseInput({
      tasks: [task({ id: 'c', agentType: 'codex-cli' })],
      codexOutcomes: new Map([['c', { kind: 'not-found', reason: 'no-candidates', candidateCount: 0 }]]),
      codexStats: { rolloutCount: 0, parseErrorCount: 0, abandonedCount: 0, orphanRollouts: [] },
    }));
    expect(r.notes.some(n => n.message.includes('Codex session directory not found'))).toBe(true);
  });
});

describe('aggregate — filters', () => {
  test('agentFilter narrows perTask + aggregate to the chosen agent', () => {
    const r = aggregate(baseInput({
      tasks: [
        task({ id: 'c1', agentType: 'claude-code' }),
        task({ id: 'x1', agentType: 'codex-cli' }),
      ],
      claudeUsage: new Map([['c1', tokenUsage({ costUsd: 1 })]]),
      codexOutcomes: new Map([['x1', boundOutcome('x1', 'gpt-5.3-codex', { in: 100, out: 10, cached: 0 })]]),
      agentFilter: 'claude-code',
    }));
    expect(r.perTask).toHaveLength(1);
    expect(r.perTask[0].agent).toBe('claude-code');
    expect(r.aggregate['codex-cli']).toBeUndefined();
  });

  test('taskNameQuery is a case-insensitive substring against name+prompt', () => {
    const r = aggregate(baseInput({
      tasks: [
        task({ id: 'a', agentType: 'claude-code', name: 'Fix Login Bug' }),
        task({ id: 'b', agentType: 'claude-code', prompt: 'refactor auth' }),
        task({ id: 'c', agentType: 'claude-code', name: 'unrelated' }),
      ],
      claudeUsage: new Map([
        ['a', tokenUsage({ costUsd: 1 })],
        ['b', tokenUsage({ costUsd: 1 })],
        ['c', tokenUsage({ costUsd: 1 })],
      ]),
      taskNameQuery: 'login',                                         // matches a only
    }));
    expect(r.perTask.map(t => t.taskId)).toEqual(['a']);
  });
});

describe('aggregate — perTask sorting', () => {
  test('rows sorted by startedAt descending (newest first)', () => {
    const r = aggregate(baseInput({
      tasks: [
        task({ id: 'old', agentType: 'claude-code', createdAt: new Date(NOW - 6 * ONE_DAY_MS) }),
        task({ id: 'mid', agentType: 'claude-code', createdAt: new Date(NOW - 3 * ONE_DAY_MS) }),
        task({ id: 'new', agentType: 'claude-code', createdAt: new Date(NOW - 1 * ONE_DAY_MS) }),
      ],
      claudeUsage: new Map([
        ['old', tokenUsage({ costUsd: 1 })],
        ['mid', tokenUsage({ costUsd: 1 })],
        ['new', tokenUsage({ costUsd: 1 })],
      ]),
    }));
    expect(r.perTask.map(t => t.taskId)).toEqual(['new', 'mid', 'old']);
  });
});

// Sanity assertion: the wire shape's CostAgent matches Task.agentType narrowed values.
const _agentSanity: CostAgent = 'claude-code';
void _agentSanity;
