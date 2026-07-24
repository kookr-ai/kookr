import type { Task } from './task-read-model.js';

/** Default silence threshold (issue #1526 Phase A / FM6): 3 hours. */
export const DEFAULT_HUNG_TASK_REAP_MS = 180 * 60 * 1000;

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
 * the three timestamps — the instant any one of them last moved.
 *
 * This function does NOT consult the watchdog's live per-tick verdict (e.g.
 * `needs_input` / `permission_blocked`) — callers must only invoke it when
 * the watchdog currently reports `stale_agent` for the agent, so a task
 * genuinely waiting on the user or a permission prompt is never reaped
 * regardless of how long it has been waiting. See hung-task-reaper.ts
 * (server) for the wiring that enforces this.
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
