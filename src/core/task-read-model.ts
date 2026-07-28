import type { CompletionDigest } from './completion-digest.js';
import type { IssueClaim } from './issue-claim-types.js';
import type { PendingAgentSignal } from '../shared/contracts/agent-signal.js';
import type { OperatorNeeded } from '../shared/contracts/operator-needed.js';
import type { AgentType } from './agent-types.js';
import type { SessionInfo } from './session-read-model.js';
import type { TaskStatus } from './task-status.js';
import type { TokenUsage } from './usage-types.js';
import type { RalphLoopState } from '../shared/contracts/ralph.js';
import type { DeliveryAuthorization, TaskDependencyEdge, TaskDisposition, TaskMetadata, TaskPriority } from '../shared/contracts/task.js';

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
 * Marker for a reflect task spawned to analyze a source task.
 * Persisted on the spawned task itself so cleanup logic can identify reflect tasks
 * by their relationship to a source task.
 */
export interface ReflectMeta {
  /** Feedback reflect is completion-feedback driven; snapshot reflect is anytime/manual. */
  kind?: 'feedback' | 'snapshot';
  /** Source task this reflect is analyzing. */
  sourceTaskId: string;
  /** Path to the immutable bundle dir the reflect was launched against. */
  bundlePath: string;
  /** Feedback reflect uses rating direction; snapshot reflect starts in review mode. */
  direction: 'up' | 'down' | 'review';
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
  /** Audit marker for the delivery policy resolved at launch. */
  deliveryAuthorization?: DeliveryAuthorization;
  /**
   * When true, the task auto-completes the moment its agent raises a
   * `completion_ready` signal (`kookr signal completion-ready`), instead of
   * waiting for manual review. Inherited from the parent task when spawning a
   * successor unless explicitly overridden. See docs/reference/auto-close-on-signal.md.
   */
  autoCloseOnSignal?: boolean;
  /**
   * Marks this task as unattended/autonomous (issue #1562): spawned with nobody
   * watching to answer an interactive prompt. When true, the spawned agent's
   * settings gain permission `deny` rules for interactive tools so a blocking
   * call fails fast (and flags the task operator-needed) instead of hanging.
   * Inherited from the parent task unless explicitly overridden, like
   * {@link autoCloseOnSignal}; set `false` to opt a successor back out.
   */
  unattended?: boolean;
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
  /**
   * True when `name` is the deterministic creation-time placeholder (issue
   * #1554), not an explicit name (playbook/user) or an LLM-generated one. The
   * async LLM namer is allowed to upgrade an auto-named task, but never an
   * explicit one; any real rename clears this flag. Absent means the name (if
   * any) is authoritative and must not be auto-overwritten.
   */
  autoNamed?: boolean;
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
  /**
   * Durable projection of this task's issue-ownership claim (RFC:
   * rfc-issue-ownership-lock). The live authority is IssueClaimRegistry's
   * in-memory map; this field is written ONLY via TaskStore.setIssueClaim /
   * clearIssueClaim, and only by the registry (RFC R3).
   */
  issueClaim?: IssueClaim;
  /** Operator-declared launch intent metadata, used by coordinator detectors. */
  metadata?: TaskMetadata;
  /** User-declared task priority. Omitted means normal priority. */
  priority?: TaskPriority;
  /** Audit marker for the delivery policy resolved at launch. */
  deliveryAuthorization?: DeliveryAuthorization;
  /**
   * When true, a `completion_ready` signal auto-completes this task immediately.
   * Set at launch (e.g. by a playbook) or inherited from the parent task.
   * See docs/reference/auto-close-on-signal.md.
   */
  autoCloseOnSignal?: boolean;
  status: TaskStatus;
  sessions: SessionInfo[];
  tokenUsage?: TokenUsage;
  /** Summary of what the agent accomplished, generated on task completion. */
  completionDigest?: CompletionDigest;
  /** User feedback on the completed task. Drives the per-task self-reflect loop. */
  completionFeedback?: TaskCompletionFeedback;
  /** Marker present iff this task is itself a reflect spawn analyzing another task. */
  reflectMeta?: ReflectMeta;
  /**
   * Pending agent → user signal (RFC: rfc-agent-signal-surface). Raised via
   * `POST /api/tasks/:id/signal`; cleared on dismiss or terminal status. Joined
   * onto the client-facing AgentState at projection time.
   */
  pendingSignal?: PendingAgentSignal;
  /**
   * How this task reached terminal-complete (issue #1608). Stamped at complete
   * time for lesson-yield v2 per-path buckets. See {@link CompletionPath} in
   * `lesson-decision.ts`. Absent on historical tasks → counted as `unknown`.
   */
  completionPath?:
    | 'normal'
    | 'outbox_drained'
    | 'recovery'
    | 'api_complete'
    | 'ui_complete'
    | 'other'
    | 'unknown';
  /**
   * Explicit reason a completion was allowed without a lesson decision
   * (issue #1608). Only meaningful when the task's hook trail has neither
   * wrote-lesson nor explicit-skip. Examples: `human_complete`,
   * `api_complete_ungated`, `recovery_reap`. Populated so yield `contractRate`
   * can treat named exceptions as explained rather than silent bypasses.
   */
  lessonGateExempt?: string;
  /**
   * Marks this task as unattended/autonomous (issue #1562). Set at launch from
   * {@link CreateTaskOptions.unattended}; drives interactive-tool deny-rule
   * injection into the spawned agent's settings and gates the operator-needed
   * flag below. Absent/false ⇒ attended, unchanged behavior.
   */
  unattended?: boolean;
  /**
   * Set when an unattended agent's interactive-tool call was denied (issue
   * #1562). Makes the block operator-visible (tasks API + dashboard task
   * detail) instead of leaving the agent hung on an unanswerable prompt.
   */
  operatorNeeded?: OperatorNeeded;
  createdAt: Date;
  updatedAt: Date;
  /**
   * First time this task entered a terminal lifecycle state. Preserved across
   * later terminal-task edits so completed history can sort by actual finish
   * time instead of "last renamed".
   */
  finishedAt?: Date;
  /** Set when the task transitions to 'terminated' via reconciliation. */
  terminatedAt?: Date;
  /**
   * Queryable evidence that a pre-session prune/terminate path disposed of this
   * task before its first agent session ever attached (issue #1588). Its
   * presence proves the task was terminated on purpose rather than silently
   * lost, and makes the task an idempotent-replay target so a retried POST with
   * the same idempotency key returns it instead of creating a sibling.
   * Absent on every task that reached a session (the overwhelming majority).
   */
  disposition?: TaskDisposition;
  /**
   * Ralph Wiggum-style iteration loop state. Present only when the task was
   * launched (or upgraded) into Ralph mode. Absence = no loop. See issue #440.
   */
  ralphLoop?: RalphLoopState;
}
