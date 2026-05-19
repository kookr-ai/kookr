import { describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
  ProgressBudgetBurnDiagnostics,
  evaluateProgressBudgetBurn,
  type ProgressBudgetBurnDiagnosticRecord,
} from './progress-budget-burn-diagnostics.js';
import type { AgentEvent, TokenUsage } from './types.js';
import type { Task } from './tasks.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    prompt: 'do work',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: 'inProgress',
    createdAt: new Date('2026-05-19T00:00:00Z'),
    updatedAt: new Date('2026-05-19T00:00:00Z'),
    sessions: [],
    ...overrides,
  };
}

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
      input(makeTask(), usage({ costUsd: 0.01, outputTokens: 10 })),
      { taskStatus: 'inProgress', costUsd: 0, tokens: 0, eventCount: 0 },
      DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
    );

    expect(record).toBeNull();
  });

  test('flags a high-confidence candidate when spend rises with no new agent events', () => {
    const record = evaluateProgressBudgetBurn(
      input(makeTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 })),
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
      input(makeTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 }), events),
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
      input(makeTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 }), events),
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
      input(makeTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 }), events),
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
      input(makeTask({ status: 'completed' }), usage({ costUsd: 0.25, cacheReadTokens: 25_000 })),
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
      input(makeTask(), usage({ costUsd: 0.25, cacheReadTokens: 25_000 }), events),
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
    const task = makeTask();

    expect(diagnostics.sample(input(task, usage({ costUsd: 0 })))).toBeNull();
    expect(diagnostics.sample(input(task, usage({ costUsd: 0.01 })))).toBeNull();
    const record = diagnostics.sample(input(task, usage({ costUsd: 0.25 })));

    expect(record?.verdict).toBe('candidate');
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toBe(record);
  });

});
