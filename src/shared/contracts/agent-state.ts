import type { AgentType } from './agent-types.js';
import type { AgentEvent } from './agent-events.js';
import type { AgentActivityMeta } from './hook-events.js';
import type { Anomaly, FindingEvidenceAuditRecord } from './anomalies.js';
import type { CompletionDigest } from './completion-digest.js';
import type { RalphLoopState, TaskCompletionFeedback, TaskDependencyEdge, TaskLaunchHealthSummary, TaskPriority } from './task.js';
import type { TaskStatus, TurnState } from './task-status.js';
import type { TokenUsage } from './usage.js';
import type { WorktreeHealth } from './session.js';

export interface AgentState {
  agentId: string;
  events: AgentEvent[];
  anomaly: Anomaly | null;
  /**
   * Current turn state of the live agent, derived from its event window.
   * Distinct from `taskStatus` (persisted lifecycle): an interactive task can
   * remain `inProgress` while its turn state is `completed_turn`. Absent for
   * synthetic pending/terminal entries that have no live event window.
   */
  turnState?: TurnState;
  snoozedUntil?: number;
  suppressed?: boolean;
  taskId?: string;
  taskName?: string;
  taskStatus?: TaskStatus;
  priority?: TaskPriority;
  parentTaskId?: string;
  childTaskIds?: string[];
  blocks?: TaskDependencyEdge[];
  blocked_by?: TaskDependencyEdge[];
  description?: string;
  cwd?: string;
  agentType?: AgentType;
  startedAt?: string;
  playbookId?: string;
  playbookParameterValues?: Record<string, string>;
  launchHealthSummary?: TaskLaunchHealthSummary;
  tokenUsage?: TokenUsage;
  gitBranch?: string;
  gitCommit?: string;
  gitIsWorktree?: boolean;
  worktreeHealth?: WorktreeHealth;
  worktreeHealthObservedAt?: string;
  worktreeRegistryStale?: boolean;
  projectId?: string;
  projectDisplayLabel?: string;
  completionDigest?: CompletionDigest;
  completionFeedback?: TaskCompletionFeedback;
  ralphLoop?: RalphLoopState;
  activityMeta?: AgentActivityMeta;
  findingEvidenceAudit?: FindingEvidenceAuditRecord;
}
