import { appendAuditRow } from '../../core/audit-log.js';
import { nowISO } from '../../core/interaction-log.js';
import {
  DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
  selectAutoClosableCompletionReadyTasks,
} from '../../core/completion/index.js';
import type { TaskStore } from '../../core/tasks.js';
import type {
  AckAllCompletionReadyResponse,
  AckAllCompletionReadySummary,
  AckAllCompletionReadyTaskResult,
} from '../../shared/contracts/supervisor-actions.js';
import type {
  TaskDeletionAuditActor,
  TaskLifecycleCommandResult,
  TaskLifecycleCommands,
} from './task-lifecycle-commands.js';

/**
 * Complete every stale `completion_ready` task in one supervisor call (issue
 * #1526 Phase B / FM12). During the 2026-07-24 deadlock, nothing had both the
 * authority and the wiring to act on `GET /api/tasks/completion-ready/stale`
 * — the endpoint was perfectly enumerating the 11 wedged tasks all day while
 * every reachable control path (Lucy, the local-model chat loop) lacked the
 * verb to drain them. This is that verb.
 *
 * Default scope mirrors the GET endpoint's `canAutoClose` policy — the same
 * tasks a caller would already see as auto-closable. `force: true` widens the
 * scope to every stale entry regardless of policy, an explicit escape hatch
 * for a true "unlock everything" drain.
 *
 * Pacing: the background Phase-A sweep (`autoCloseStaleCompletionReadyTasks`
 * in lifecycle-timers.ts) spaces completions across ticks (max 2 per 60s) to
 * avoid the multi-MB snapshot-broadcast storm that contributed to the
 * 2026-07-24 overload (11 simultaneous session teardowns, each broadcasting a
 * full snapshot). That tick-based throttle is not trivially reusable inside a
 * single synchronous request/response — a supervisor calling this endpoint
 * needs a complete per-task result set back in one response, not a partial
 * batch spread over minutes. This function therefore acts immediately on
 * every matched task instead of waiting. It still avoids the specific
 * overload mechanism: individual `completeTask` calls only emit small
 * `alert`/`update` broadcasts, and the expensive full-snapshot broadcast is
 * left to the caller (the REST route), which broadcasts once after the whole
 * batch completes — not once per task.
 */
export async function ackAllStaleCompletionReadyTasks(
  deps: {
    taskStore: Pick<TaskStore, 'listTasks'>;
    lifecycleCommands: Pick<TaskLifecycleCommands, 'completeTask'>;
    auditLogPath?: string;
  },
  opts: {
    force?: boolean;
    thresholdMs?: number;
    ttlMs?: number;
    actor?: TaskDeletionAuditActor;
    now?: Date;
  } = {},
): Promise<AckAllCompletionReadyResponse> {
  const force = opts.force === true;
  const entries = selectAutoClosableCompletionReadyTasks(deps.taskStore.listTasks(), {
    now: opts.now,
    thresholdMs: opts.thresholdMs ?? DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
    ttlMs: opts.ttlMs,
    force,
  });

  const results: AckAllCompletionReadyTaskResult[] = [];
  for (const entry of entries) {
    const taskId = entry.task.id;
    try {
      const result = await deps.lifecycleCommands.completeTask(taskId, { actor: opts.actor });
      results.push(mapCompleteResult(taskId, result));
    } catch (err) {
      results.push({
        taskId,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = summarize(results);
  if (summary.completed > 0 || summary.partial_ralph_completion > 0 || summary.failed > 0) {
    await appendAuditRow(deps.auditLogPath, {
      type: 'task.completionReadyAckAll',
      timestamp: nowISO(),
      actor: opts.actor ?? { source: 'unknown' },
      force,
      count: entries.length,
      summary,
      results,
    });
  }

  return { force, results, summary };
}

function mapCompleteResult(taskId: string, result: TaskLifecycleCommandResult): AckAllCompletionReadyTaskResult {
  switch (result.outcome) {
    case 'completed':
    case 'partial_ralph_completion':
    case 'already_terminal':
      return { taskId, outcome: result.outcome, status: result.task.status };
    case 'not_found':
      return { taskId, outcome: 'not_found' };
    case 'invalid':
      return { taskId, outcome: 'invalid', error: result.error };
    default:
      return { taskId, outcome: 'failed', error: `unexpected complete outcome: ${result.outcome}` };
  }
}

function summarize(results: AckAllCompletionReadyTaskResult[]): AckAllCompletionReadySummary {
  const summary: AckAllCompletionReadySummary = {
    matched: results.length,
    completed: 0,
    already_terminal: 0,
    partial_ralph_completion: 0,
    invalid: 0,
    not_found: 0,
    failed: 0,
  };
  for (const r of results) {
    summary[r.outcome] += 1;
  }
  return summary;
}
