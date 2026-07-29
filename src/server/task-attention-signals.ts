import type { Task } from '../core/tasks.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { Watchdog } from '../core/watchdog.js';
import { isTaskHungSuspect, type HungTaskLivenessEvidence } from '../core/hung-task-reaper.js';

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
   * Raw liveness timestamps for the task's agent (`Watchdog.getState`), or
   * `undefined` when the task has no session or the watchdog has no state for
   * it. Fed to `deriveStuckReason`'s `waiting_on_input` liveness cross-check
   * (issue #1653) so an actively-working agent is never flagged.
   */
  liveness?: HungTaskLivenessEvidence;
}

const NO_SIGNALS: TaskAttentionSignals = { hungSuspect: false, queuedAnomalyType: null };

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

  const queuedAnomalyType = deps.queue?.peek(agentId)?.type ?? null;
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

  return { hungSuspect, queuedAnomalyType, liveness };
}
