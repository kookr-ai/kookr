import type { Task } from './task-read-model.js';
import type { TaskStatus, TerminationReason } from './task-status.js';
import { isTerminalStatus } from './task-status.js';
import type {
  TaskTerminalReceipt,
  TerminalReasonCategory,
  TerminalTransitionContext,
  TerminalTransitionSource,
  TerminalWorkDisposition,
} from '../shared/contracts/task.js';

/**
 * Structured terminal-transition provenance (issue #2847). Pure helpers shared
 * by the core task store (which stamps the receipt at the lifecycle chokepoint)
 * and the server API / diagnostics (which project legacy rows and aggregate
 * outcomes). No I/O — safe to import from either layer.
 */

/**
 * Map a {@link TerminationReason} (the terminated-only cause the store already
 * records) onto the broader {@link TerminalReasonCategory}. Used to derive a
 * receipt reason when a `terminateTask` caller supplies a cause but no explicit
 * receipt context, so most terminated tasks classify correctly for free.
 */
export function reasonCategoryFromTermination(reason: TerminationReason): TerminalReasonCategory {
  switch (reason) {
    case 'server-restart':
      return 'server_restart';
    case 'oom':
      return 'oom';
    case 'timeout':
      return 'timeout';
    case 'manual':
      return 'manual';
    case 'supervisor':
      return 'supervisor';
    case 'provider_transient':
      return 'provider_failure';
    case 'unknown':
      return 'unknown';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Best-effort initiator for a terminated task derived from its
 * {@link TerminationReason}. A caller with better knowledge (e.g. the boot
 * reconcile, which knows the path is restart-recovery) overrides this.
 */
export function sourceFromTermination(reason: TerminationReason): TerminalTransitionSource {
  switch (reason) {
    case 'server-restart':
      return 'restart_recovery';
    case 'oom':
    case 'timeout':
      return 'watchdog';
    case 'manual':
      return 'user';
    case 'supervisor':
      return 'supervisor';
    case 'provider_transient':
      return 'task_self';
    case 'unknown':
      return 'unknown';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Derive receipt provenance for a COMPLETED task from its already-resolved
 * {@link Task.completionPath} (issue #1608). Lets `completeTask` classify the
 * initiator (agent self vs operator vs recovery) without a second inference:
 * the completion path already encodes it.
 */
export function terminalContextFromCompletionPath(
  path: Task['completionPath'],
): TerminalTransitionContext {
  switch (path) {
    case 'recovery':
      return { source: 'restart_recovery', reason: 'completed_recovery' };
    case 'api_complete':
    case 'ui_complete':
      return { source: 'user', reason: 'completed_normal' };
    case 'normal':
    case 'outbox_drained':
      return { source: 'task_self', reason: 'completed_normal' };
    case 'other':
    case 'unknown':
    case undefined:
      return { reason: 'completed_normal' };
  }
}

/** Per-terminal-status defaults for a receipt when the caller omits fields. */
function defaultsForStatus(status: TaskStatus): {
  reason: TerminalReasonCategory;
  workDisposition: TerminalWorkDisposition;
} {
  switch (status) {
    case 'completed':
      return { reason: 'completed_normal', workDisposition: 'completed' };
    case 'cancelled':
      return { reason: 'manual', workDisposition: 'abandoned' };
    case 'terminated':
      return { reason: 'unknown', workDisposition: 'abandoned' };
    default:
      // Non-terminal statuses never produce a receipt; keep the switch total.
      return { reason: 'unknown', workDisposition: 'unknown' };
  }
}

/**
 * Build the receipt stamped at a terminal transition. `priorState` and `at` are
 * always known at the chokepoint; everything else falls back to per-status
 * defaults so even a context-less legacy call site yields a non-empty typed
 * reason and source (never `unknown_legacy`, which is reserved for rows that
 * predate the field).
 */
export function buildTerminalReceipt(
  status: 'completed' | 'terminated' | 'cancelled',
  priorState: TaskStatus,
  at: string,
  context: TerminalTransitionContext = {},
): TaskTerminalReceipt {
  const defaults = defaultsForStatus(status);
  const receipt: TaskTerminalReceipt = {
    status,
    reason: context.reason ?? defaults.reason,
    source: context.source ?? 'unknown',
    at,
    priorState,
    workDisposition: context.workDisposition ?? defaults.workDisposition,
  };
  if (context.recoveryCorrelationId !== undefined) {
    receipt.recoveryCorrelationId = context.recoveryCorrelationId;
  }
  if (context.detail !== undefined) receipt.detail = context.detail;
  return receipt;
}

/**
 * The receipt to expose for a task through the API. Returns the stored receipt
 * verbatim when present; for a terminal task that predates the field, synthesizes
 * an explicit `unknown_legacy` receipt so legacy rows stay readable and are
 * classified as unknown rather than guessed (issue #2847 AC). Returns `undefined`
 * for a non-terminal task.
 */
export function projectTerminalReceipt(task: Task): TaskTerminalReceipt | undefined {
  // Gate on CURRENT status first: a task reopened/relaunched after termination
  // keeps its last terminal receipt as durable history, but must not surface it
  // while it is active again (it would misreport a running task as terminated
  // and double-count it in the terminal histogram). Only when the task is
  // actually terminal do we expose the stored receipt, or synthesize the
  // legacy default for a terminal row that predates the field.
  if (!isTerminalStatus(task.status)) return undefined;
  if (task.terminalReceipt) return task.terminalReceipt;
  const at = (task.finishedAt ?? task.terminatedAt ?? task.updatedAt).toISOString();
  return {
    status: task.status as 'completed' | 'terminated' | 'cancelled',
    reason: 'unknown_legacy',
    source: 'unknown_legacy',
    at,
    workDisposition: 'unknown',
  };
}

export interface TerminalOutcomeAggregate {
  windowMs: number;
  generatedAt: string;
  /** Terminal tasks whose transition falls inside the window. */
  total: number;
  byReason: Record<string, number>;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  byWorkDisposition: Record<string, number>;
}

/**
 * Aggregate terminal outcomes over a bounded trailing window (issue #2847 AC:
 * "Diagnostics can aggregate terminal outcomes by reason over a bounded
 * window"). Pure over an already-bounded task list — the caller passes
 * `taskStore.viewTasks()`, whose size is capped by store retention. Legacy rows
 * project to `unknown_legacy`, so nothing is silently dropped.
 */
export function aggregateTerminalOutcomes(
  tasks: readonly Task[],
  opts: { nowMs: number; windowMs: number },
): TerminalOutcomeAggregate {
  const cutoff = opts.nowMs - opts.windowMs;
  const byReason: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byWorkDisposition: Record<string, number> = {};
  let total = 0;

  for (const task of tasks) {
    const receipt = projectTerminalReceipt(task);
    if (!receipt) continue;
    const atMs = Date.parse(receipt.at);
    if (!Number.isFinite(atMs) || atMs < cutoff) continue;
    total += 1;
    byReason[receipt.reason] = (byReason[receipt.reason] ?? 0) + 1;
    bySource[receipt.source] = (bySource[receipt.source] ?? 0) + 1;
    byStatus[receipt.status] = (byStatus[receipt.status] ?? 0) + 1;
    byWorkDisposition[receipt.workDisposition] =
      (byWorkDisposition[receipt.workDisposition] ?? 0) + 1;
  }

  return {
    windowMs: opts.windowMs,
    generatedAt: new Date(opts.nowMs).toISOString(),
    total,
    byReason,
    bySource,
    byStatus,
    byWorkDisposition,
  };
}
