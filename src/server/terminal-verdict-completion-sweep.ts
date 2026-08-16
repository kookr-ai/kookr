/**
 * Terminal-success verdict auto-completion sweep (issue #2532).
 *
 * Enforces the lifecycle invariant: an agent that reaches an unambiguous
 * terminal-SUCCESS verdict must convert to a completed, slot-releasing state
 * instead of parking in `needs_input` "awaiting input" with no question to ask.
 *
 * The motivating symptom: two Deploy Convergence agents reached the verdict
 * `converged` — nothing left to decide — yet sat in `needs_input` holding two of
 * sixteen fleet slots indefinitely, because a clean Stop with a success verdict
 * is not, on its own, converted to completion (the live Stop-hook nudge is
 * advisory only and never raises a signal; `evaluateCompletionSignal` only
 * auto-signals delivery-authorized tasks). This sweep closes that gap generally,
 * not per-playbook.
 *
 * It runs on the liveness tick alongside the sibling reclaim sweeps
 * (`delivered-task-completion-sweep`, `completion-ready-sweep`, the FAA
 * reapers). For each running task that is:
 *   - not a Ralph loop, and carries no pending signal (a signalled task is the
 *     finishedAwaitingAck path's job, not this one),
 *   - not provider-paused (a billing/quota pause is never a completion),
 *   - not delivery-gated pending delivery (an `ask-first` task whose delivery is
 *     not satisfied must never be auto-marked done),
 *   - PARKED in `needs_input` with subType `stop` (i.e. nothing to ask — never a
 *     live `ask_user_question`), and
 *   - whose final clean-turn message classifies as a terminal-success verdict
 *     (`core/terminal-success-verdict.ts`),
 * it force-completes the task via the normal `completeTask` transition (stamping
 * `interactionLogReason: 'terminal_success_auto_complete'`), surfaces any dirty
 * worktree first (so uncommitted work is never silently discarded, issue #1580),
 * writes an audit row, and broadcasts one alert. Non-success parks (drift,
 * divergent, verification failure) and genuine questions never match, so they
 * keep parking in `needs_input` unchanged.
 *
 * Gating on the live `needs_input` anomaly is what makes text-verdict matching
 * safe: the anomaly only fires once the agent is genuinely idle at the prompt
 * past the watchdog's staleness threshold, so a task mid-work that merely
 * printed a "complete" line is never a candidate.
 */

import type { Anomaly, AgentEvent } from '../core/types.js';
import type { SessionInfo } from '../core/session-read-model.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { completeTask, type LifecycleDeps } from './agent-lifecycle.js';
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import {
  classifyTerminalSuccessVerdict,
  type TerminalSuccessVerdict,
} from '../core/terminal-success-verdict.js';

/**
 * Max terminal-success tasks completed per sweep. Same rationale as the
 * auto-close / delivered per-batch caps: each completion tears down sessions and
 * broadcasts a snapshot, so a backlog drains across ticks rather than all at once.
 */
export const DEFAULT_MAX_TERMINAL_VERDICT_COMPLETE_PER_TICK = 2;

/** Actor stamped on the audit row for a terminal-success verdict auto-complete. */
export const TERMINAL_VERDICT_AUTO_COMPLETE_ACTOR = 'system:terminal-verdict-auto-complete';

/** Minimal monitor surface this sweep reads — the live anomaly + event stream per session. */
export interface TerminalVerdictMonitor {
  getCurrentAnomaly(agentId: string): Anomaly | null;
  getAgentEvents(agentId: string): AgentEvent[];
}

export interface AutoCompleteTerminalVerdictDeps {
  taskStore: TaskStore;
  /** Lifecycle context threaded to `completeTask`; absent ⇒ the sweep is a no-op. */
  lifecycleDeps?: LifecycleDeps;
  /** Live anomaly + event source used to detect the park and read the final message. */
  monitor: TerminalVerdictMonitor;
  /**
   * Issue #1667: true when the agent is provider-paused (billing/quota). A pause
   * is never a completion, so a paused task is skipped. Production reuses the
   * same event/pane predicate as the auto-close / delivered sweeps; tests inject
   * a fake. Optional — omit ⇒ never paused.
   */
  isProviderPaused?: (task: Task) => boolean;
  auditLogPath?: string;
  broadcastToAll?: (msg: ServerMessage) => void;
  now?: () => Date;
}

export interface AutoCompleteTerminalVerdictOptions {
  maxPerTick?: number;
}

export interface AutoCompleteTerminalVerdictResult {
  completedTaskIds: string[];
}

function isActiveRalphLoop(task: Task): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

function firstLiveSession(task: Task): SessionInfo | undefined {
  return task.sessions.find(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && !s.crashRecovered,
  );
}

/** Latest clean-turn final message: the `lastMessage` of the most recent `stop` event. */
function latestStopMessage(events: readonly AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === 'stop') return e.lastMessage;
    // A newer non-stop terminal event means the turn is not cleanly stopped.
    if (e.type === 'user_prompt' || e.type === 'input_received' || e.type === 'tool_use') return undefined;
  }
  return undefined;
}

/**
 * Whether a task is parked in `needs_input` with nothing to ask (subType `stop`).
 * A live `ask_user_question` carries a concrete question and must NEVER be
 * auto-completed — that is the "entering needs_input requires a concrete
 * question" half of the invariant, enforced by exclusion here.
 */
function isParkedWithoutQuestion(anomaly: Anomaly | null): boolean {
  return anomaly?.type === 'needs_input' && anomaly.subType !== 'ask_user_question';
}

async function recordTerminalVerdictAutoComplete(
  deps: AutoCompleteTerminalVerdictDeps,
  task: Task,
  verdict: TerminalSuccessVerdict,
): Promise<void> {
  await appendAuditRow(deps.auditLogPath, {
    type: 'task.terminalSuccessAutoCompleted',
    timestamp: nowISO(),
    actor: TERMINAL_VERDICT_AUTO_COMPLETE_ACTOR,
    taskId: task.id,
    reason: 'terminal_success_auto_complete',
    verdict,
    ...(task.playbookId ? { playbookId: task.playbookId } : {}),
  });
  deps.broadcastToAll?.({
    type: 'alert',
    agentId: task.sessions[task.sessions.length - 1]?.tmuxSession ?? '',
    summary: `Auto-completed on terminal-success verdict: ${task.name ?? 'Task'}`,
    details:
      `Agent reached an unambiguous success verdict ("${verdict}") and parked in needs_input with no `
      + 'question to ask — completed automatically to free the slot instead of holding it awaiting input.',
    severity: 'info',
  });
}

/**
 * Complete running tasks that reached a terminal-success verdict but parked in
 * `needs_input` (issue #2532). See module header. Returns the ids completed this
 * tick. Never throws for a single task — a raced terminal transition is logged
 * and skipped so the sweep keeps draining the rest of the batch.
 */
export async function autoCompleteTerminalVerdictTasks(
  deps: AutoCompleteTerminalVerdictDeps,
  opts: AutoCompleteTerminalVerdictOptions = {},
): Promise<AutoCompleteTerminalVerdictResult> {
  const completedTaskIds: string[] = [];
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return { completedTaskIds };

  const maxPerTick = opts.maxPerTick ?? DEFAULT_MAX_TERMINAL_VERDICT_COMPLETE_PER_TICK;
  let completedThisTick = 0;

  for (const task of deps.taskStore.viewTasks()) {
    if (task.status !== 'inProgress') continue;
    if (isActiveRalphLoop(task)) continue;
    // A signalled task belongs to the finishedAwaitingAck reclaim path, not here.
    if (task.pendingSignal) continue;
    // A billing/quota pause is not a completion (issue #1667 parity).
    if (deps.isProviderPaused?.(task) === true) continue;
    // A delivery-gated (`ask-first`) task must never be auto-marked done on a
    // text verdict — its completion is owned by an explicit human ack or the
    // delivered-PR sweep (merged-PR evidence), never a needs_input park.
    if (task.deliveryAuthorization === 'ask-first') continue;

    const session = firstLiveSession(task);
    if (!session) continue;

    // Must be genuinely PARKED in needs_input with no concrete question. The
    // watchdog only mints needs_input once the agent is idle at the prompt past
    // the staleness threshold, so this excludes tasks that are still working.
    const anomaly = deps.monitor.getCurrentAnomaly(session.tmuxSession);
    if (!isParkedWithoutQuestion(anomaly)) continue;

    const finalMessage = latestStopMessage(deps.monitor.getAgentEvents(session.tmuxSession));
    const match = classifyTerminalSuccessVerdict(finalMessage);
    if (!match) continue;

    // Per-batch cap: leave the rest for the next tick.
    if (completedThisTick >= maxPerTick) break;

    try {
      // Surface (never discard silently) uncommitted work before completing —
      // same headless-completion guard as the auto-close / delivered sweeps.
      await surfaceDirtyWorktreeOnHeadlessCompletion(task, {
        taskStore: deps.taskStore,
        auditLogPath: deps.auditLogPath,
        broadcastToAll: deps.broadcastToAll,
      });
      await completeTask(task.id, lifecycleDeps, {
        actorSource: TERMINAL_VERDICT_AUTO_COMPLETE_ACTOR,
        interactionLogReason: 'terminal_success_auto_complete',
      });
      // Only a successful completion consumes the per-tick budget and the audit
      // trail — a raced/failed completion must not burn a slot or alert. The
      // audit row + one alert carry the verdict/line; no per-task success log
      // (matching the sibling delivered / auto-close sweeps).
      completedThisTick += 1;
      completedTaskIds.push(task.id);
      await recordTerminalVerdictAutoComplete(deps, task, match.verdict);
    } catch (err) {
      // Raced a manual ack or another terminal transition — skip; the task is no
      // longer this sweep's to finish. Keeps draining the rest of the batch.
      console.error(
        `[terminal-verdict-auto-complete] auto-complete failed for task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
  }

  return { completedTaskIds };
}
