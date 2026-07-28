import type { AgentType } from './agent-types.js';
import type { AgentEvent } from './agent-events.js';
import type { AgentActivityMeta } from './hook-events.js';
import type { Anomaly, AnomalySeverity, FindingEvidenceAuditRecord } from './anomalies.js';
import type { PendingAgentSignal } from './agent-signal.js';
import type { OperatorNeeded } from './operator-needed.js';
import type { TaskStuckReason } from './task-stuck-reason.js';
import type { CompletionDigest } from './completion-digest.js';
import type { LatestCompletionSignal } from './completion-signal.js';
import type {
  RalphLoopState,
  TaskCompletionFeedback,
  TaskDependencyEdge,
  TaskLaunchHealthSummary,
  TaskLaunchPermissionPosture,
  TaskPriority,
  TaskReapOutcome,
} from './task.js';
import type { TaskStatus, TurnState } from './task-status.js';
import type { TaskRelationRollup } from './task-relations.js';
import type { TokenUsage } from './usage.js';
import type { WorktreeHealth } from './session.js';
import type { TerminalInputSnapshot } from './terminal-input.js';
import type { UserInputDeliverySnapshot } from './user-input-delivery.js';
import type { SessionHealthSnapshot } from './session-health.js';

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
  /**
   * ISO timestamp for the first terminal transition. Present on synthetic
   * completed/cancelled/terminated entries so the dashboard can show and sort
   * completed history by finish time.
   */
  finishedAt?: string;
  playbookId?: string;
  playbookParameterValues?: Record<string, string>;
  launchHealthSummary?: TaskLaunchHealthSummary;
  launchPermissionPosture?: TaskLaunchPermissionPosture;
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
  latestCompletionSignal?: LatestCompletionSignal;
  completionFeedback?: TaskCompletionFeedback;
  ralphLoop?: RalphLoopState;
  activityMeta?: AgentActivityMeta;
  userInputDeliveries?: UserInputDeliverySnapshot[];
  findingEvidenceAudit?: FindingEvidenceAuditRecord;
  terminalInputSnapshot?: TerminalInputSnapshot;
  /**
   * Sequence number of the last event in {@link events}, or `0` when the
   * window is empty (including synthetic pending/terminal entries). Populated
   * by {@link Monitor.getSnapshot} so speak-summary consumers can detect when
   * fresh activity arrived between cache hit and TTS playback.
   */
  lastEventSeq?: number;
  /**
   * Per-parent rollup of child task state. Populated by the snapshot builder
   * (#601) when this agent's task has at least one active child relation. The
   * rollup is derived from the typed relation graph (#599) joined with live
   * agent state at projection time — the parent's persisted anomaly is never
   * mutated. Frontend uses the rollup for the parent-row pill and the
   * "show children" filter.
   */
  childRollup?: TaskRelationRollup;
  /**
   * Derived severity used for attention ranking. When a child task carries an
   * active anomaly more severe than the parent's own (or the parent has no
   * own anomaly at all), the snapshot builder sets this to the child's
   * severity so the parent surfaces alongside its child without inheriting
   * the child's actionable state. Equal to `anomaly.severity` when no child
   * is more severe. Absent when the parent has no own anomaly and no child
   * finding to bump from.
   */
  effectiveAttentionSeverity?: AnomalySeverity;
  /**
   * Pending agent → user signal (RFC: rfc-agent-signal-surface), joined from
   * the task record onto the client-facing state at projection time. Like
   * {@link childRollup}, this is populated only by the snapshot builder — the
   * raw Monitor AgentState never carries it. Absent when no signal is raised.
   */
  pendingSignal?: PendingAgentSignal;
  /**
   * True when this task was launched unattended/autonomous (issue #1562),
   * projected from the task record so the dashboard can label the task and
   * contextualize the operator-needed flag below. Absent ⇒ attended.
   */
  unattended?: boolean;
  /**
   * Set when an unattended agent's interactive-tool call was denied (issue
   * #1562), projected from the task record. Drives the dashboard operator-needed
   * banner so the block is visible instead of an open-ended hang. Absent when
   * no interactive call has been denied.
   */
  operatorNeeded?: OperatorNeeded;
  /**
   * Reap outcome projected from the task's disposition (issue #1559). Present
   * only on a reaped `terminated` entry; `delivered_then_hung` when the reaper
   * found an attributable merged PR, so the dashboard renders it distinctly
   * from a plain `terminated` instead of masking the delivery as failure.
   */
  reapOutcome?: TaskReapOutcome;
  /**
   * Why an `inProgress` task is occupying a capacity slot without visible work
   * (issue #1526 Phase B / FM9) — awaiting the user's completion ack,
   * watchdog-suspected hung, waiting on input, or permission-blocked. Derived
   * from `pendingSignal` and `anomaly` at projection time (see
   * `core/stuck-reason.ts`); absent when the task isn't `inProgress` or isn't
   * stuck. Companion to `GET /api/health`'s `capacity.byClass` aggregate.
   */
  stuckReason?: TaskStuckReason;
  /** Cross-signal terminal/session health, projected when the session is live. */
  sessionHealth?: SessionHealthSnapshot;
}
