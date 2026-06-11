import type { RalphLoopState } from './ralph.js';

export type TaskDependencyEdge = `task:${string}` | `milestone:${string}`;
export type TaskMetadataIntent = 'keep_as_duplicate';
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
