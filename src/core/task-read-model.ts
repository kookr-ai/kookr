import type { CompletionDigest } from './completion-digest.js';
import type { AgentType } from './agent-types.js';
import type { SessionInfo } from './session-read-model.js';
import type { TaskStatus } from './task-status.js';
import type { TokenUsage } from './usage-types.js';
import type { RalphLoopState } from '../shared/contracts/ralph.js';
import type { TaskDependencyEdge, TaskMetadata, TaskPriority } from '../shared/contracts/task.js';

export type {
  BurnedOutTarget,
  RalphLoopState,
  RalphLoopStatus,
  RalphStallConfig,
  RalphZeroDiffConvergenceConfig,
} from '../shared/contracts/ralph.js';

/**
 * User feedback on a completed task. Drives the per-task self-reflect loop.
 * `rating` is always required; `note` and `downReason` are optional enrichment.
 * Stored on `Task.completionFeedback` and persisted to the interaction log.
 */
export interface TaskCompletionFeedback {
  rating: 'up' | 'down';
  /** Free-text note, sanitized server-side before persistence. */
  note?: string;
  /** Only meaningful when rating === 'down'. */
  downReason?: 'agent_behavior' | 'my_prompt';
}

/**
 * Marker for a reflect task spawned to analyze a completed source task.
 * Persisted on the spawned task itself so cleanup logic can identify reflect tasks
 * by their relationship to a source task.
 */
export interface ReflectMeta {
  /** Source task this reflect is analyzing. */
  sourceTaskId: string;
  /** Path to the immutable feedback bundle dir the reflect was launched against. */
  bundlePath: string;
  /** 'up' triggers reinforcement branch in the skill; 'down' triggers fix-proposal branch. */
  direction: 'up' | 'down';
  /**
   * Absolute path of the ephemeral worktree allocated for this reflect task.
   * Set at spawn so the terminal-state cleanup can remove exactly this worktree
   * without scanning. Optional for backward-compat with reflect tasks persisted
   * before this field existed — those fall back to the startup sweep.
   */
  worktreePath?: string;
}

export interface CreateTaskOptions {
  /** Raw execution prompt sent to the agent. May include Kookr launch-context guidance. */
  prompt: string;
  /** Original user-authored prompt before Kookr launch-context injection. */
  userPrompt?: string;
  cwd: string;
  criteria?: string;
  parentTaskId?: string;
  agentType?: AgentType;
  name?: string;
  playbookId?: string;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
  /** Advisory diagnostics captured during launch without changing task identity. */
  launchHealthSummary?: TaskLaunchHealthSummary;
  /** Warning text prepended to the first agent prompt, but not stored in `prompt`. */
  launchNote?: string;
  /** Normalized project identifier (e.g. "github.com/owner/repo" or "local/dirname"). */
  projectId?: string;
  /** Operator-declared launch intent metadata, used by coordinator detectors. */
  metadata?: TaskMetadata;
  /** User-declared task priority. Omitted means normal priority. */
  priority?: TaskPriority;
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

export interface Task {
  id: string;
  name?: string;
  /** Original user-authored prompt before Kookr launch-context injection. */
  userPrompt?: string;
  /** Raw execution prompt sent to the agent. May include Kookr launch-context guidance. */
  prompt: string;
  cwd: string;
  criteria?: string;
  agentType: AgentType;
  playbookId?: string;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
  /** Advisory launch diagnostics. Does not affect duplicate detection. */
  launchHealthSummary?: TaskLaunchHealthSummary;
  /** Warning text prepended to the actual launch prompt, but not part of `prompt`. */
  launchNote?: string;
  parentTaskId?: string;
  childTaskIds?: string[];
  /** User-declared dependency edges for tasks this task blocks. */
  blocks?: TaskDependencyEdge[];
  /** User-declared dependency edges for tasks or milestones blocking this task. */
  blocked_by?: TaskDependencyEdge[];
  /** Normalized project identifier (e.g. "github.com/owner/repo" or "local/dirname"). */
  projectId?: string;
  /** Operator-declared launch intent metadata, used by coordinator detectors. */
  metadata?: TaskMetadata;
  /** User-declared task priority. Omitted means normal priority. */
  priority?: TaskPriority;
  status: TaskStatus;
  sessions: SessionInfo[];
  tokenUsage?: TokenUsage;
  /** Summary of what the agent accomplished, generated on task completion. */
  completionDigest?: CompletionDigest;
  /** User feedback on the completed task. Drives the per-task self-reflect loop. */
  completionFeedback?: TaskCompletionFeedback;
  /** Marker present iff this task is itself a reflect spawn analyzing another task. */
  reflectMeta?: ReflectMeta;
  createdAt: Date;
  updatedAt: Date;
  /** Set when the task transitions to 'terminated' via reconciliation. */
  terminatedAt?: Date;
  /**
   * Ralph Wiggum-style iteration loop state. Present only when the task was
   * launched (or upgraded) into Ralph mode. Absence = no loop. See issue #440.
   */
  ralphLoop?: RalphLoopState;
}
