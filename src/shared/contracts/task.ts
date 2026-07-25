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
