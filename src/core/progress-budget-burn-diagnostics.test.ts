import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
  ProgressBudgetBurnDiagnostics,
  JsonlProgressBudgetBurnDiagnosticSink,
  evaluateProgressBudgetBurn,
  type ProgressBudgetBurnDiagnosticRecord,
} from './progress-budget-burn-diagnostics.js';
import type { AgentEvent, TokenUsage } from './types.js';
import type { Task } from './tasks.js';
import { aTask } from './__fixtures__/task-builders.js';

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

function input(
  task: Task,
  tokenUsage: TokenUsage,
  events: AgentEvent[] = [],
) {
  return {
    task,
    agentId: 'agent-1',
    usage: tokenUsage,
    events,
    now: new Date('2026-05-19T12:00:00Z'),
  };
}

describe('evaluateProgressBudgetBurn', () => {
  test('returns null until cost or token delta crosses the diagnostic threshold', () => {
    const record = evaluateProgressBudgetBurn(
      input(aTask(), usage({ costUsd: 0.01, outputTokens: 10 })),
      { taskStatus: 'inProgress', costUsd: 0, tokens: 0, eventCount: 0 },
      DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
    );

    expect(record).toBeNull();
  });

  test('flags a high-confidence candidate when spend rises with no new agent events', () => {
    const record = evaluateProgressBudgetBurn(
      input(aTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 })),
      { taskStatus: 'inProgress', costUsd: 0, tokens: 0, eventCount: 0 },
      DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
    );

    expect(record).toMatchObject({
      schemaVersion: 'progress-budget-burn-diagnostic.v1',
      mode: 'diagnostics_only',
      activeQueueInsertionEnabled: false,
      detector: 'progress_aware_budget_burn',
      verdict: 'candidate',
      confidence: 'high',
      evidenceLabels: expect.arrayContaining([
        'cost_delta_positive',
        'token_delta_positive',
        'task_status_unchanged',
        'no_new_agent_events',
      ]),
      deltas: {
        costUsd: 0.25,
        tokens: 25_000,
        eventCount: 0,
      },
    });
  });

  test('keeps samples healthy when a meaningful progress event arrives in the same window', () => {
    const events: AgentEvent[] = [
      { type: 'tool_result', sessionId: 'agent-1', toolName: 'Bash', eventSeq: 1 },
    ];
    const record = evaluateProgressBudgetBurn(
      input(aTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 }), events),
      { taskStatus: 'inProgress', costUsd: 0, tokens: 0, eventCount: 0 },
      DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
    );

    expect(record?.verdict).toBe('healthy');
    expect(record?.confidence).toBeNull();
    expect(record?.evidenceLabels).toContain('meaningful_event_progress');
  });

  test('flags repeated errors as medium-confidence no-progress evidence', () => {
    const events: AgentEvent[] = [
      { type: 'error', sessionId: 'agent-1', message: 'same error', eventSeq: 1 },
      { type: 'error', sessionId: 'agent-1', message: 'same error', eventSeq: 2 },
      { type: 'error', sessionId: 'agent-1', message: 'same error', eventSeq: 3 },
    ];
    const record = evaluateProgressBudgetBurn(
      input(aTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 }), events),
      { taskStatus: 'inProgress', costUsd: 0, tokens: 0, eventCount: 0 },
      DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
    );

    expect(record?.verdict).toBe('candidate');
    expect(record?.confidence).toBe('medium');
    expect(record?.evidenceLabels).toEqual(expect.arrayContaining([
      'only_non_progress_events',
      'repeated_error_state',
    ]));
  });

  test('flags permission requests as high-confidence no-progress evidence', () => {
    const events: AgentEvent[] = [
      { type: 'permission_request', sessionId: 'agent-1', toolName: 'Bash', eventSeq: 1 },
    ];
    const record = evaluateProgressBudgetBurn(
      input(aTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 }), events),
      { taskStatus: 'inProgress', costUsd: 0, tokens: 0, eventCount: 0 },
      DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
    );

    expect(record?.verdict).toBe('candidate');
    expect(record?.confidence).toBe('high');
    expect(record?.evidenceLabels).toEqual(expect.arrayContaining([
      'only_non_progress_events',
      'permission_blocked_state',
    ]));
  });

  test('keeps samples healthy when task status changes during the spend window', () => {
    const record = evaluateProgressBudgetBurn(
      input(aTask({ status: 'completed' }), usage({ costUsd: 0.25, cacheReadTokens: 25_000 })),
      { taskStatus: 'inProgress', costUsd: 0, tokens: 0, eventCount: 0 },
      DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
    );

    expect(record?.verdict).toBe('healthy');
    expect(record?.evidenceLabels).toContain('task_status_changed');
  });

  test('does not classify completed turns as budget-burn candidates', () => {
    const events: AgentEvent[] = [
      { type: 'stop', sessionId: 'agent-1', lastMessage: 'Done', eventSeq: 1 },
    ];
    const record = evaluateProgressBudgetBurn(
      input(aTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 }), events),
      { taskStatus: 'inProgress', costUsd: 0, tokens: 0, eventCount: 0 },
      DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
    );

    expect(record?.verdict).toBe('healthy');
    expect(record?.evidenceLabels).toContain('completed_turn_state');
  });
});

describe('ProgressBudgetBurnDiagnostics', () => {
  test('is stateful and appends only threshold-crossing diagnostic samples', () => {
    const append = vi.fn<(record: ProgressBudgetBurnDiagnosticRecord) => void>();
    const diagnostics = new ProgressBudgetBurnDiagnostics({}, { append });
    const task = aTask();

    expect(diagnostics.sample(input(task, usage({ costUsd: 0 })))).toBeNull();
    expect(diagnostics.sample(input(task, usage({ costUsd: 0.01 })))).toBeNull();
    const record = diagnostics.sample(input(task, usage({ costUsd: 0.25 })));

    expect(record?.verdict).toBe('candidate');
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toBe(record);
  });

});

describe('JsonlProgressBudgetBurnDiagnosticSink', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-budget-burn-'));
    logPath = join(tempDir, 'budget-burn-diagnostics.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function aRecord(seq: number): ProgressBudgetBurnDiagnosticRecord {
    return {
      schemaVersion: 'progress-budget-burn-diagnostic.v1',
      mode: 'diagnostics_only',
      activeQueueInsertionEnabled: false,
      detector: 'progress_aware_budget_burn',
      timestamp: new Date('2026-05-19T12:00:00Z').toISOString(),
      taskId: `task-${seq}`,
      agentId: 'agent-1',
      taskStatus: 'inProgress',
      verdict: 'candidate',
      confidence: 'high',
      reason: 'test record',
      totals: { costUsd: 1, tokens: 1 },
      deltas: { costUsd: 1, tokens: 1, eventCount: 0 },
      evidenceLabels: ['no_new_agent_events'],
    };
  }

  test('writes records and creates the log file under the given path', async () => {
    const sink = new JsonlProgressBudgetBurnDiagnosticSink(logPath);
    sink.append(aRecord(1));
    await sink.flush();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).taskId).toBe('task-1');
  });

  test('rotates to bounded generations once maxLogBytes is exceeded', async () => {
    // Cap comfortably above one record (~450 bytes) so the file accumulates
    // several records before rotating, rather than rotating on every append.
    const MAX_BYTES = 2 * 1024;
    const sink = new JsonlProgressBudgetBurnDiagnosticSink(logPath, {
      maxLogBytes: MAX_BYTES,
      rotatedGenerations: 2,
    });

    for (let i = 0; i < 200; i++) {
      sink.append(aRecord(i));
    }
    await sink.flush();

    // Live file stays bounded near the cap (plus at most one overshooting line).
    expect(statSync(logPath).size).toBeLessThanOrEqual(MAX_BYTES + 512);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    // Nothing beyond the configured generation count survives.
    expect(existsSync(`${logPath}.3`)).toBe(false);
  });

  test('serializes appends across rotation without losing or duplicating records', async () => {
    // A tiny cap forces a rotation every few records; a generous generation
    // count retains them all, so the full sequence is recoverable and any
    // stat/rotate/append race would show up as a gap or a duplicate.
    const sink = new JsonlProgressBudgetBurnDiagnosticSink(logPath, {
      maxLogBytes: 800,
      rotatedGenerations: 60,
    });

    for (let i = 0; i < 50; i++) sink.append(aRecord(i));
    await sink.flush();

    const seqs: number[] = [];
    const files = [logPath, ...Array.from({ length: 60 }, (_, g) => `${logPath}.${g + 1}`)];
    for (const file of files) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf-8').trim().split('\n')) {
        if (line) seqs.push(Number(JSON.parse(line).taskId.replace('task-', '')));
      }
    }

    expect(new Set(seqs).size).toBe(50);
    expect(seqs.sort((a, b) => a - b)).toEqual([...Array(50).keys()]);
  });
});
