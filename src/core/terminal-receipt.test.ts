import { describe, test, expect } from 'vitest';
import type { Task } from './task-read-model.js';
import type { TaskStatus } from './task-status.js';
import type { TaskTerminalReceipt } from '../shared/contracts/task.js';
import {
  aggregateTerminalOutcomes,
  buildTerminalReceipt,
  projectTerminalReceipt,
  reasonCategoryFromTermination,
  sourceFromTermination,
  terminalContextFromCompletionPath,
} from './terminal-receipt.js';

/**
 * Minimal Task shaped just enough for the pure receipt helpers, which only read
 * status / terminalReceipt / finishedAt / terminatedAt / updatedAt.
 */
function fakeTask(overrides: {
  status: TaskStatus;
  terminalReceipt?: TaskTerminalReceipt;
  finishedAt?: Date;
  updatedAt?: Date;
}): Task {
  return {
    status: overrides.status,
    terminalReceipt: overrides.terminalReceipt,
    finishedAt: overrides.finishedAt,
    updatedAt: overrides.updatedAt ?? new Date('2026-08-26T00:00:00.000Z'),
  } as unknown as Task;
}

describe('terminal-receipt helpers (issue #2847)', () => {
  describe('reason/source derivation from TerminationReason', () => {
    // Exact expected mapping for every TerminationReason member — a wrong
    // mapping (e.g. oom -> user) fails here, not just an empty one.
    test.each([
      ['server-restart', 'server_restart', 'restart_recovery'],
      ['oom', 'oom', 'watchdog'],
      ['timeout', 'timeout', 'watchdog'],
      ['manual', 'manual', 'user'],
      ['supervisor', 'supervisor', 'supervisor'],
      ['provider_transient', 'provider_failure', 'task_self'],
      ['unknown', 'unknown', 'unknown'],
    ] as const)('%s -> reason %s, source %s', (reason, expectedReason, expectedSource) => {
      expect(reasonCategoryFromTermination(reason)).toBe(expectedReason);
      expect(sourceFromTermination(reason)).toBe(expectedSource);
    });
  });

  describe('terminalContextFromCompletionPath', () => {
    test('recovery completion is restart-recovery sourced', () => {
      expect(terminalContextFromCompletionPath('recovery')).toEqual({
        source: 'restart_recovery',
        reason: 'completed_recovery',
      });
    });
    test('api/ui completion is user sourced', () => {
      expect(terminalContextFromCompletionPath('api_complete').source).toBe('user');
      expect(terminalContextFromCompletionPath('ui_complete').source).toBe('user');
    });
    test('normal completion is task-self sourced', () => {
      expect(terminalContextFromCompletionPath('normal').source).toBe('task_self');
      expect(terminalContextFromCompletionPath('outbox_drained').source).toBe('task_self');
    });
    test('unknown/undefined path leaves source unset but reason set', () => {
      expect(terminalContextFromCompletionPath(undefined)).toEqual({ reason: 'completed_normal' });
    });
  });

  describe('buildTerminalReceipt', () => {
    test('fills per-status defaults when no context supplied', () => {
      const receipt = buildTerminalReceipt('terminated', 'inProgress', '2026-08-26T01:00:00.000Z');
      expect(receipt).toMatchObject({
        status: 'terminated',
        reason: 'unknown',
        source: 'unknown',
        priorState: 'inProgress',
        workDisposition: 'abandoned',
        at: '2026-08-26T01:00:00.000Z',
      });
    });

    test('context overrides defaults', () => {
      const receipt = buildTerminalReceipt('cancelled', 'pending', '2026-08-26T01:00:00.000Z', {
        source: 'schedule',
        workDisposition: 'superseded',
        recoveryCorrelationId: 'epoch-1',
        detail: 'unwound duplicate',
      });
      expect(receipt.source).toBe('schedule');
      expect(receipt.workDisposition).toBe('superseded');
      expect(receipt.recoveryCorrelationId).toBe('epoch-1');
      expect(receipt.detail).toBe('unwound duplicate');
    });
  });

  describe('projectTerminalReceipt (legacy backward-compat)', () => {
    test('returns the stored receipt verbatim when present', () => {
      const stored: TaskTerminalReceipt = {
        status: 'terminated', reason: 'timeout', source: 'watchdog',
        at: '2026-08-26T02:00:00.000Z', priorState: 'inProgress', workDisposition: 'abandoned',
      };
      expect(projectTerminalReceipt(fakeTask({ status: 'terminated', terminalReceipt: stored }))).toBe(stored);
    });

    test('synthesizes an explicit unknown_legacy receipt for a receiptless terminal task', () => {
      const finishedAt = new Date('2026-08-25T12:00:00.000Z');
      const receipt = projectTerminalReceipt(fakeTask({ status: 'cancelled', finishedAt }));
      expect(receipt).toEqual({
        status: 'cancelled',
        reason: 'unknown_legacy',
        source: 'unknown_legacy',
        at: finishedAt.toISOString(),
        workDisposition: 'unknown',
      });
    });

    test('returns undefined for a non-terminal task', () => {
      expect(projectTerminalReceipt(fakeTask({ status: 'inProgress' }))).toBeUndefined();
    });

    test('gates on CURRENT status: a reopened task hides its stale terminal receipt', () => {
      // A relaunched/reopened task keeps its last terminal receipt as history,
      // but must not surface it while active again (issue #2847).
      const stale: TaskTerminalReceipt = {
        status: 'terminated', reason: 'server_restart', source: 'restart_recovery',
        at: '2026-08-26T02:00:00.000Z', priorState: 'inProgress', workDisposition: 'relaunched',
      };
      expect(projectTerminalReceipt(fakeTask({ status: 'inProgress', terminalReceipt: stale }))).toBeUndefined();
    });
  });

  describe('aggregateTerminalOutcomes', () => {
    const nowMs = Date.parse('2026-08-26T12:00:00.000Z');
    const windowMs = 24 * 60 * 60 * 1000;

    test('buckets by reason, source, status, and work-disposition within the window', () => {
      const tasks = [
        fakeTask({
          status: 'terminated',
          terminalReceipt: {
            status: 'terminated', reason: 'timeout', source: 'watchdog',
            at: '2026-08-26T06:00:00.000Z', priorState: 'inProgress', workDisposition: 'abandoned',
          },
        }),
        fakeTask({
          status: 'terminated',
          terminalReceipt: {
            status: 'terminated', reason: 'server_restart', source: 'restart_recovery',
            at: '2026-08-26T05:00:00.000Z', priorState: 'open', workDisposition: 'relaunched',
          },
        }),
        // Legacy row (no receipt) → unknown_legacy.
        fakeTask({ status: 'cancelled', finishedAt: new Date('2026-08-26T04:00:00.000Z') }),
      ];

      const agg = aggregateTerminalOutcomes(tasks, { nowMs, windowMs });
      expect(agg.total).toBe(3);
      expect(agg.byReason).toEqual({ timeout: 1, server_restart: 1, unknown_legacy: 1 });
      expect(agg.bySource).toEqual({ watchdog: 1, restart_recovery: 1, unknown_legacy: 1 });
      expect(agg.byStatus).toEqual({ terminated: 2, cancelled: 1 });
      expect(agg.byWorkDisposition).toEqual({ abandoned: 1, relaunched: 1, unknown: 1 });
    });

    test('excludes transitions older than the window and non-terminal tasks', () => {
      const tasks = [
        fakeTask({
          status: 'terminated',
          terminalReceipt: {
            status: 'terminated', reason: 'timeout', source: 'watchdog',
            at: '2026-08-20T00:00:00.000Z', priorState: 'inProgress', workDisposition: 'abandoned',
          },
        }),
        fakeTask({ status: 'inProgress' }),
      ];
      const agg = aggregateTerminalOutcomes(tasks, { nowMs, windowMs });
      expect(agg.total).toBe(0);
      expect(agg.byReason).toEqual({});
    });
  });
});
