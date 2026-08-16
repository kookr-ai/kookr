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
  type TerminalSuccessVerdictMatch,
} from '../core/terminal-success-verdict.js';
import { deriveTurnStateDetails } from '../core/turn-state.js';

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
  /**
   * Open-PR fail-safe for delivery-gated (`ask-first`) tasks (issue #2532
   * independent review). An `ask-first` task is completed only when this
   * positively confirms it holds no open PR (returns `false`) — so a converged
   * deploy-verification task with no pending delivery still auto-completes
   * (issue AC), while one whose PR is unmerged is left for the human / the
   * delivered-PR sweep. Absent or `undefined` ⇒ the task is treated as
   * possibly-holding and skipped (fail-safe), mirroring the predicate the FAA /
   * delivered sweeps use.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
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

/**
 * The task's SOLE live session, or undefined when there is not exactly one.
 * SessionRegistry can hold more than one live session after an attach race, and
 * completing the task tears down ALL of them — so a receipt on an older session
 * must never complete a task whose newer session is still working. Fail closed:
 * act only when the live session is unambiguous.
 */
function soleLiveSession(task: Task): SessionInfo | undefined {
  const live = task.sessions.filter(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && !s.crashRecovered,
  );
  return live.length === 1 ? live[0] : undefined;
}

/**
 * The final message of a genuinely COMPLETED clean turn, or undefined. Reuses
 * `deriveTurnStateDetails` (the same clean-turn evidence the completion-signal
 * machinery uses), so a Stop that is actually `running` — e.g. one that reports
 * active background tasks / session crons — is NOT treated as a completed turn
 * and never yields a message to classify. This is what stops the sweep from
 * completing a task whose agent printed its receipt while a background poll /
 * verification is still live.
 */
function completedTurnFinalMessage(events: readonly AgentEvent[]): string | undefined {
  const details = deriveTurnStateDetails(events as AgentEvent[]);
  if (details.turnState !== 'completed_turn') return undefined;
  const stop = details.effectiveEvent;
  if (!stop || stop.type !== 'stop') return undefined;
  return stop.lastMessage;
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
/**
 * All eligibility gates for one task, in one place, returning the matched verdict
 * when the task is a terminal-success park to complete — else null. Reads live
 * monitor state, so calling it a second time (after an await) re-checks against
 * the CURRENT state, which is exactly the TOCTOU re-validation the sweep needs.
 */
function evaluateCandidate(
  deps: AutoCompleteTerminalVerdictDeps,
  task: Task,
): TerminalSuccessVerdictMatch | null {
  if (task.status !== 'inProgress') return null;
  if (isActiveRalphLoop(task)) return null;
  // A signalled task belongs to the finishedAwaitingAck reclaim path, not here.
  if (task.pendingSignal) return null;
  // A billing/quota pause is not a completion (issue #1667 parity).
  if (deps.isProviderPaused?.(task) === true) return null;
  // A delivery-gated (`ask-first`) task is completed only when its delivery is
  // positively clear: skip unless `isHoldingOpenPr` confirms it holds no open PR
  // (returns false). Absent/unknown ⇒ skip (fail-safe). This still lets a
  // converged deploy-verification task with no pending delivery complete (issue
  // AC), while never auto-completing one whose PR is still unmerged.
  if (task.deliveryAuthorization === 'ask-first' && deps.isHoldingOpenPr?.(task) !== false) return null;

  // Only act on an unambiguous single live session (fail closed on the
  // attach-race duplicate-session state, so a receipt on an older session can
  // never tear down a newer one that is still working).
  const session = soleLiveSession(task);
  if (!session) return null;

  // Must be genuinely PARKED in needs_input with no concrete question. The
  // watchdog only mints needs_input once the agent is idle at the prompt past the
  // staleness threshold, so this excludes tasks that are still working.
  if (!isParkedWithoutQuestion(deps.monitor.getCurrentAnomaly(session.tmuxSession))) return null;

  // Require a genuinely COMPLETED clean turn — a Stop still reporting active
  // background tasks / crons is `running`, not done, and yields no message.
  const finalMessage = completedTurnFinalMessage(deps.monitor.getAgentEvents(session.tmuxSession));
  return classifyTerminalSuccessVerdict(finalMessage);
}

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
    const match = evaluateCandidate(deps, task);
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
      // TOCTOU re-validation (Lucy #2238 pattern): the awaited worktree inspection
      // above yields the event loop, during which the agent may have resumed
      // (new turn), signalled, or the record may have raced to terminal. Re-fetch
      // the LIVE record and re-run every gate against current monitor state
      // before the irreversible completeTask; skip (without burning budget) if it
      // is no longer a clean terminal-success park.
      const fresh = deps.taskStore.getTask(task.id);
      const revalidated = fresh ? evaluateCandidate(deps, fresh) : null;
      if (!fresh || !revalidated) {
        console.warn(
          `[terminal-verdict-auto-complete] task ${task.id} no longer eligible after worktree inspection — skipping`,
        );
        continue;
      }
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
      await recordTerminalVerdictAutoComplete(deps, fresh, revalidated.verdict);
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
