import type { RalphLoopState } from './ralph.js';

export type TaskDependencyEdge = `task:${string}` | `milestone:${string}`;

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
