import type { TaskStatus } from './task-status.js';
import type { PendingAgentSignal } from '../shared/contracts/agent-signal.js';
import type { TaskStuckReason } from '../shared/contracts/task-stuck-reason.js';

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
  if (input.anomalyType === 'needs_input') return 'waiting_on_input';
  if (input.anomalyType === 'permission_blocked') return 'permission_blocked';
  return null;
}
