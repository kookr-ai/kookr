import type { Task } from './task-read-model.js';
import type { MergedPrAttribution } from './delivered-task-completion.js';
import type { TaskDisposition, TaskReapOutcome } from '../shared/contracts/task.js';

/** Default silence threshold (issue #1526 Phase A / FM6): 3 hours. */
export const DEFAULT_HUNG_TASK_REAP_MS = 180 * 60 * 1000;

/**
 * Classify a hung-task reap outcome (issue #1559) from its delivery attribution.
 *
 * `delivered_then_hung` iff the task has an attributable merged PR — the same
 * attribution the delivered-completion sweep reads (#1560,
 * `selectDeliveredMergedPr` over `GitHubStateStore`). Otherwise `terminated`,
 * so a reaped task that produced nothing never falsely reads as delivered.
 */
export function classifyReapOutcome(merged: MergedPrAttribution | null | undefined): TaskReapOutcome {
  return merged ? 'delivered_then_hung' : 'terminated';
}

/**
 * Build the disposition entry the hung-task reaper writes (issue #1559),
 * reusing the shared {@link TaskDisposition} schema (#1588/#1540) — one
 * mechanism, no parallel ledger. Carries the reap `outcome` and, on delivery,
 * the attributable merged PR so the API and dashboard can surface
 * `delivered_then_hung` distinctly from a plain `terminated`.
 */
export function buildReapDisposition(
  merged: MergedPrAttribution | null | undefined,
  at: string,
): TaskDisposition {
  const outcome = classifyReapOutcome(merged);
  const disposition: TaskDisposition = {
    reason: 'hung_reap',
    at,
    source: 'hung-task-reaper',
    outcome,
  };
  if (merged) {
    disposition.deliveredPr = {
      number: merged.prNumber,
      ...(merged.prUrl ? { url: merged.prUrl } : {}),
    };
    disposition.detail = `Delivered PR #${merged.prNumber} before hanging; reaped after prolonged silence.`;
  }
  return disposition;
}

/** Raw liveness timestamps for a single agent session (ms since epoch, 0 = never recorded). */
export interface HungTaskLivenessEvidence {
  /** Last hook event (Watchdog.getState(agentId).lastEventAt). */
  lastHookEventAt: number;
  /** Last time the captured pane content genuinely changed (Watchdog.getState(agentId).lastPaneChangeAt). */
  lastPaneChangeAt: number;
  /** Last time transcript token usage moved (Watchdog.getState(agentId).lastTokenActivityAt). */
  lastTokenActivityAt: number;
}

export type HungTaskReapIneligibleReason =
  /** A2 hard exclusion: the task's population overlaps A1's — it already has a pending signal. */
  | 'has_pending_signal'
  /** The task isn't an active in-progress task (not launched yet, or already terminal). */
  | 'not_in_progress'
  /** At least one liveness channel is not yet silent for the full threshold. */
  | 'not_silent_enough';

export type HungTaskReapVerdict =
  | { eligible: true; silentForMs: number }
  | { eligible: false; reason: HungTaskReapIneligibleReason };

/**
 * Pure eligibility check for the hung-task reaper (issue #1526 Phase A / FM6).
 *
 * A task is reap-eligible only when ALL THREE liveness channels have been
 * silent for at least `thresholdMs`: no hook events, no pane-content change,
 * no token-count movement. "Silent for" is computed from the MOST RECENT of
 * the three timestamps — the instant any one of them last moved. This is
 * independent of the watchdog's own short-timescale thresholds: a hook event
 * an hour ago, with a 3h reap threshold, keeps the hook channel "live" and
 * blocks the reap regardless of anything else.
 *
 * This function does NOT consult the watchdog's live per-tick verdict (e.g.
 * `needs_input` / `permission_blocked`) — callers must only invoke it when
 * the watchdog currently reports `stale_agent` for the agent, so a task
 * genuinely waiting on the user or a permission prompt is never reaped
 * regardless of how long it has been waiting. Note that `stale_agent` does
 * NOT mean "no tool in progress": the watchdog also returns it for a tool
 * left unmatched (PreToolUse with no PostToolUse) once it's been silent past
 * the watchdog's own maxToolExecutionTimeMs (10 min default) — a tool that's
 * been silent past THIS function's much larger threshold (hours) is still
 * correctly reap-eligible; that's exactly the incident's hung task (last
 * event a PreToolUse, pane frozen mid-write, silent for 33h). See
 * server/hung-task-reaper.ts and the watchdog-tick wiring in
 * server/lifecycle-timers.ts for the full gate this function depends on.
 */
export function evaluateHungTaskReap(
  task: Pick<Task, 'status' | 'pendingSignal'>,
  liveness: HungTaskLivenessEvidence,
  opts: { now: number; thresholdMs?: number },
): HungTaskReapVerdict {
  if (task.pendingSignal) return { eligible: false, reason: 'has_pending_signal' };
  if (task.status !== 'inProgress') return { eligible: false, reason: 'not_in_progress' };

  const thresholdMs = opts.thresholdMs ?? DEFAULT_HUNG_TASK_REAP_MS;
  const lastActivityAt = Math.max(
    liveness.lastHookEventAt,
    liveness.lastPaneChangeAt,
    liveness.lastTokenActivityAt,
  );
  const silentForMs = opts.now - lastActivityAt;
  if (silentForMs < thresholdMs) return { eligible: false, reason: 'not_silent_enough' };

  return { eligible: true, silentForMs };
}

/** Evidence available to {@link isTaskHungSuspect} without a fresh watchdog tick. */
export interface HungSuspectEvidence {
  /**
   * Anomaly type currently queued for this task's agent in the AttentionQueue
   * (`AttentionQueue.peek(agentId)?.type`), or `null`/`undefined` when nothing
   * is queued. When this is `'stale_agent'`, it IS the watchdog's own verdict
   * from its last full-context `tick()` (pane capture + tool-in-progress +
   * grace-period-aware) — trusted directly, no re-derivation.
   */
  queuedAnomalyType?: string | null;
  /**
   * Raw liveness timestamps for the agent (`Watchdog.getState(agentId)`).
   * `undefined` when the watchdog has no state for this agent (never
   * registered, or unregistered after session end) — callers MUST treat that
   * as "not hung suspect", never as "silent since epoch".
   */
  liveness?: HungTaskLivenessEvidence;
  /**
   * `Watchdog.hasToolInProgress(agentId)`. A tool left unmatched keeps the
   * hook-event channel from advancing even though the agent is genuinely
   * working — the fallback below must not mistake that for silence (that's
   * exactly what `tick()`'s own `toolInProgress` gate protects against, and
   * what `evaluateHungTaskReap` deliberately does NOT check on its own — see
   * its doc comment).
   */
  toolInProgress: boolean;
  /**
   * The watchdog's own `unconditionalStaleThresholdMs` (`Watchdog.getConfig()`),
   * NOT the (much larger) hung-task reap threshold — this flags a suspect
   * early, well before the reaper would act.
   */
  unconditionalStaleThresholdMs: number;
}

/**
 * Cheap, in-memory "is this task's agent hung-suspect right now" check (issue
 * #1526 Phase B). Used by the capacity ledger (`GET /api/health`) and the
 * per-task `stuckReason` projection — both hot paths that must classify O(active
 * tasks) tasks per request with no disk reads and no pane captures, so calling
 * `Watchdog.tick()` directly is not an option.
 *
 * Reuses exactly two already-exposed Phase A/watchdog primitives instead of
 * inventing a new detector:
 * 1. The watchdog's actual last `stale_agent` verdict, if still queued
 *    (`queuedAnomalyType`) — the highest-fidelity signal, computed with full
 *    tick() context (pane capture, tool-in-progress, grace period).
 * 2. A fallback for when that verdict was never queued or was purged/suppressed
 *    (e.g. by the subagent or systemic-hook-stall suppressors in
 *    `Monitor.applyWatchdogVerdict`): `evaluateHungTaskReap`'s own
 *    all-channels-silent computation, gated on `!toolInProgress` (mirroring
 *    `tick()`'s own gate) and using the watchdog's short-timescale
 *    `unconditionalStaleThresholdMs` instead of the reaper's much larger
 *    reap threshold.
 */
export function isTaskHungSuspect(
  task: Pick<Task, 'status' | 'pendingSignal'>,
  evidence: HungSuspectEvidence,
  opts: { now: number },
): boolean {
  if (evidence.queuedAnomalyType === 'stale_agent') return true;
  if (evidence.toolInProgress) return false;
  if (!evidence.liveness) return false;
  return evaluateHungTaskReap(task, evidence.liveness, {
    now: opts.now,
    thresholdMs: evidence.unconditionalStaleThresholdMs,
  }).eligible;
}
