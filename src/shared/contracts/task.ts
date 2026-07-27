import type { RalphLoopState } from './ralph.js';

export type TaskDependencyEdge = `task:${string}` | `milestone:${string}`;
export type TaskMetadataIntent = 'keep_as_duplicate';

/**
 * Where a launch originated (issue #1526 Phase C / C3 extends the original
 * log-provenance union with `websocket` and `schedule`). Single source of
 * truth for `LaunchOpts.launchSource`, the per-source spawn budget's bucket
 * key, and the `metadata.launchSource` stamp on the created task record.
 */
export type TaskLaunchSource =
  | 'cli'
  | 'ui'
  | 'api'
  | 'websocket'
  | 'schedule'
  | 'remote-chat-telegram'
  | 'remote-relay';
export type TaskPriority = 'high';
export type TaskPriorityUpdate = TaskPriority | 'normal';
export type DeliveryAuthorization = 'pre-authorized' | 'ask-first';

export interface TaskLaunchPermissionPosture {
  bypassAllPermissions: true;
  mode: 'bypass-all';
  capturedAt: string;
}

export interface TaskMetadata {
  intent?: TaskMetadataIntent;
  /** Audit marker for tasks launched while permission prompts were globally bypassed. */
  launchPermissionPosture?: TaskLaunchPermissionPosture;
  /**
   * Where this task's launch originated (issue #1526 Phase C / C3). Stamped
   * at createTask time so the promotion posture guard can recognize
   * schedule-fired pendings as self-releasing (they run under schedule
   * coalescing/supervision) without a new top-level Task field. Absent on
   * tasks created before this change and on paths that never set a source.
   */
  launchSource?: TaskLaunchSource;
}

export interface TaskCompletionFeedback {
  rating: 'up' | 'down';
  note?: string;
  downReason?: 'agent_behavior' | 'my_prompt';
}

/**
 * Why a task was pruned or terminated BEFORE its first agent session ever
 * attached (issue #1588). Under CPU saturation, `POST /api/tasks` could create
 * a task that a launch-timeout cleanup, a boot-time stale-open-launch
 * reconcile, or overload shedding then removed before any session existed —
 * silently, so the record vanished and a retried POST created a duplicate.
 *
 * The invariant this closes: once a task is persisted it is never removed or
 * terminated without an explicit, queryable disposition. A disposed task stays
 * in the store (queryable via `GET /api/tasks/:id`), and a retried POST with
 * the same idempotency key returns THIS task — disposition visible — instead
 * of a sibling.
 */
export type TaskDispositionReason =
  /** Adapter launch exceeded the hard launch timeout (issue #1528). */
  | 'launch_timeout'
  /** Adapter launch threw before any session attached. */
  | 'launch_error'
  /** Boot reconcile terminated an `open` zero-session task whose launcher died with the previous process. */
  | 'stale_open_launch';

/**
 * Queryable disposition record for a pre-session prune/terminate (issue #1588).
 *
 * This is the single disposition mechanism for pre-session prunes — the
 * recovery work-conservation ledger (#1540) is expected to build ITS
 * disposition records on this same shape rather than a parallel one.
 */
export interface TaskDisposition {
  /** Why the task was pruned/terminated before its first session. */
  reason: TaskDispositionReason;
  /** ISO-8601 timestamp the disposition was recorded. */
  at: string;
  /** Subsystem that recorded it (e.g. 'launch-service', 'startup-reconcile'). */
  source: string;
  /** Optional human-readable detail (e.g. the underlying launch error message). */
  detail?: string;
}

export interface TaskLaunchHealthSummary {
  degradedDependencies: string[];
  findings: TaskLaunchHealthFinding[];
}

export interface TaskLaunchHealthFinding {
  dependency: string;
  status: 'failed';
  category: string;
  summary: string;
  detail?: string;
  recommendedAction: string;
}

export type { RalphLoopState };
