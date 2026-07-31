import type { Task } from '../core/tasks.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { Watchdog } from '../core/watchdog.js';
import { isTaskHungSuspect, type HungTaskLivenessEvidence } from '../core/hung-task-reaper.js';
import { isProviderPaused as classifyIsProviderPaused } from '../core/provider-pause.js';
import type { AnomalyReconciliation } from '../core/anomaly-types.js';

/**
 * Structural task shape this module needs — deliberately narrower than
 * `Task` (just `status`/`pendingSignal`/session-tmux-ids) so callers that
 * already hold a projected shape (`ApiTask`, `CompactApiTask`) can pass it
 * straight through without widening to a full session record.
 */
export interface TaskAttentionSubject {
  status: Task['status'];
  pendingSignal?: Task['pendingSignal'];
  sessions: Array<{ tmuxSession: string }>;
}

/**
 * Per-task attention signals resolved from already-in-memory watchdog/queue
 * state (issue #1526 Phase B). Shared by the capacity ledger (`GET
 * /api/health`) and the `stuckReason` REST projection (`GET /api/tasks`) so
 * both surfaces agree on whether the same task is hung-suspect — computing
 * this once per task keeps each caller a single Map-get pass, safe for a
 * polled hot path (no disk reads, no pane captures).
 */
export interface TaskAttentionSignals {
  hungSuspect: boolean;
  /** `AttentionQueue.peek(agentId)?.type`, or `null` when nothing is queued or the task has no session yet. */
  queuedAnomalyType: string | null;
  /**
   * Issue #1667: true when the queued anomaly (or optional event evidence)
   * indicates a billing/quota provider pause. Fed to `deriveStuckReason` so
   * status surfaces show `provider_paused` instead of hung/working.
   */
  providerPaused: boolean;
  /**
   * Raw liveness timestamps for the task's agent (`Watchdog.getState`), or
   * `undefined` when the task has no session or the watchdog has no state for
   * it. Fed to `deriveStuckReason`'s `waiting_on_input` liveness cross-check
   * (issue #1653) so an actively-working agent is never flagged.
   */
  liveness?: HungTaskLivenessEvidence;
  /**
   * Issue #1148: true when the queued anomaly's publish/merge reconciliation
   * classified the state as `pr-green-mergeable` — a structured merge-ready
   * signal, not an operator-facing blocker. Dashboard/status surfaces should
   * treat this task as ready to merge rather than waiting on the operator.
   */
  mergeReady: boolean;
  /**
   * Issue #1148: the queued anomaly's publish/merge reconciliation verdict
   * (classification + reason code), when present, so the dashboard/logs can
   * explain why a publish/merge blocker was suppressed, replaced with a
   * merge-ready signal, or left in place as a real blocker.
   */
  reconciliation?: Pick<AnomalyReconciliation, 'classification' | 'reasonCode'>;
}

const NO_SIGNALS: TaskAttentionSignals = {
  hungSuspect: false,
  queuedAnomalyType: null,
  providerPaused: false,
  mergeReady: false,
};

/**
 * Resolve attention signals for one task. Uses the task's most recent session
 * (`task.sessions.at(-1)`) as the watchdog/queue agent id, matching the
 * convention already used by `hung-task-reaper.ts` and
 * `snapshot-projection.ts`. Returns the all-false default for a task with no
 * sessions yet (pending/open, not launched) — nothing to look up.
 */
export function resolveTaskAttentionSignals(
  task: TaskAttentionSubject,
  deps: { queue?: Pick<AttentionQueue, 'peek'>; watchdog?: Pick<Watchdog, 'getState' | 'getConfig' | 'hasToolInProgress'> },
  now: number,
): TaskAttentionSignals {
  const agentId = task.sessions[task.sessions.length - 1]?.tmuxSession;
  if (!agentId) return NO_SIGNALS;

  const queued = deps.queue?.peek(agentId) ?? null;
  const queuedAnomalyType = queued?.type ?? null;
  const state = deps.watchdog?.getState(agentId);
  const liveness: HungTaskLivenessEvidence | undefined = state
    ? { lastHookEventAt: state.lastEventAt, lastPaneChangeAt: state.lastPaneChangeAt, lastTokenActivityAt: state.lastTokenActivityAt }
    : undefined;
  const hungSuspect = isTaskHungSuspect(
    task,
    {
      queuedAnomalyType,
      liveness,
      toolInProgress: deps.watchdog?.hasToolInProgress(agentId) ?? false,
      unconditionalStaleThresholdMs: deps.watchdog?.getConfig().unconditionalStaleThresholdMs ?? Infinity,
    },
    { now },
  );
  const providerPaused = classifyIsProviderPaused({
    anomalyType: queuedAnomalyType,
    anomalyExplanation: queued?.explanation ?? null,
  });
  const reconciliation = queued?.reconciliation
    ? { classification: queued.reconciliation.classification, reasonCode: queued.reconciliation.reasonCode }
    : undefined;
  const mergeReady = reconciliation?.classification === 'pr-green-mergeable';

  return { hungSuspect, queuedAnomalyType, providerPaused, liveness, mergeReady, ...(reconciliation ? { reconciliation } : {}) };
}
