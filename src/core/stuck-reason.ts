import type { TaskStatus } from './task-status.js';
import type { PendingAgentSignal } from '../shared/contracts/agent-signal.js';
import type { TaskStuckReason } from '../shared/contracts/task-stuck-reason.js';
import { hasRecentLiveness, type HungTaskLivenessEvidence } from './hung-task-reaper.js';

/**
 * Default liveness grace for the `waiting_on_input` cross-check (issue #1653):
 * a task with hook / pane / token activity within the last 60s is demonstrably
 * working and must never be flagged `waiting_on_input`. Matches the 60s window
 * the dogfooding-night false positives were disproven within (spinner / token
 * counter animating in the same minute the flag fired).
 */
export const DEFAULT_WAITING_ON_INPUT_LIVENESS_GRACE_MS = 60_000;

/**
 * Inputs needed to derive a task's `stuckReason` (issue #1526 Phase B). Every
 * field is something already tracked elsewhere — this function invents no new
 * signal, it only picks between existing ones in priority order:
 *
 * 1. `pendingSignal` (`completion_ready`) — the agent itself declared it's
 *    done; this always wins over any liveness/attention state.
 * 2. `hungSuspect` — see `core/hung-task-reaper.ts#isTaskHungSuspect`, which
 *    is the ONLY place that combines the watchdog's queued `stale_agent`
 *    verdict with its all-channels-silent fallback. Callers compute this
 *    once and pass the boolean in rather than this function re-deriving it,
 *    so the capacity ledger's `hungSuspect` byClass and a task's
 *    `stuckReason: 'hung_suspect'` can never disagree for the same task.
 * 3. `anomalyType` — the task's currently active/queued finding type
 *    (`AttentionQueue.peek(agentId)?.type` or the client-facing
 *    `AgentState.anomaly?.type`, depending on caller). Only `needs_input` and
 *    `permission_blocked` map to a stuck reason; anything else (or none) means
 *    the task is genuinely working.
 */
export interface StuckReasonInput {
  status: TaskStatus;
  pendingSignal?: Pick<PendingAgentSignal, 'kind'>;
  /** Precomputed via `isTaskHungSuspect` — see class doc above. */
  hungSuspect?: boolean;
  anomalyType?: string | null;
  /**
   * Raw liveness timestamps for the task's agent (`Watchdog.getState`), issue
   * #1653. When supplied together with {@link now}, a `needs_input` anomaly
   * that would map to `waiting_on_input` is suppressed if any channel moved
   * within {@link livenessGraceMs}: the agent is actively working, so the flag
   * would be a false alarm. Optional and additive — omit both and behaviour is
   * unchanged from before the cross-check existed.
   */
  liveness?: HungTaskLivenessEvidence;
  /** Current time (ms since epoch). Required for the {@link liveness} cross-check. */
  now?: number;
  /** Override the {@link DEFAULT_WAITING_ON_INPUT_LIVENESS_GRACE_MS} grace window. */
  livenessGraceMs?: number;
}

/**
 * Would a `waiting_on_input` flag on this task be a liveness false positive
 * (issue #1653)? True only when liveness evidence and `now` are supplied AND a
 * hook / pane / token channel advanced within the grace window. Exported so the
 * REST projection can record the suppressed would-be false positive for the
 * precision counter without re-deriving the whole priority chain.
 */
export function isWaitingOnInputSuppressedByLiveness(
  input: Pick<StuckReasonInput, 'liveness' | 'now' | 'livenessGraceMs'>,
): boolean {
  if (!input.liveness || input.now === undefined) return false;
  return hasRecentLiveness(
    input.liveness,
    input.now,
    input.livenessGraceMs ?? DEFAULT_WAITING_ON_INPUT_LIVENESS_GRACE_MS,
  );
}

/**
 * Derive the `stuckReason` for a single task (issue #1526 Phase B). Returns
 * `null` for anything that isn't `inProgress` (matches the capacity ledger's
 * `classifyTaskCapacity`: a `pendingSignal` on a non-`inProgress` task, e.g. a
 * stale/orphaned record, is not counted).
 */
export function deriveStuckReason(input: StuckReasonInput): TaskStuckReason | null {
  if (input.status !== 'inProgress') return null;
  if (input.pendingSignal?.kind === 'completion_ready') return 'awaiting_completion_ack';
  if (input.hungSuspect || input.anomalyType === 'stale_agent') return 'hung_suspect';
  if (input.anomalyType === 'needs_input') {
    // #1653: don't flag a demonstrably-working agent. A live spinner / running
    // shell / animating token counter within the last minute advances the
    // watchdog's hook/pane/token timestamps, so the flag is a false alarm.
    if (isWaitingOnInputSuppressedByLiveness(input)) return null;
    return 'waiting_on_input';
  }
  if (input.anomalyType === 'permission_blocked') return 'permission_blocked';
  return null;
}
