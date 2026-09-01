import type { CompletionDigest } from './completion-digest.js';
import type { IssueClaim } from './issue-claim-types.js';
import type { PendingAgentSignal } from '../shared/contracts/agent-signal.js';
import type { OperatorNeeded } from '../shared/contracts/operator-needed.js';
import type { AgentType } from './agent-types.js';
import type { SessionInfo } from './session-read-model.js';
import type { TaskStatus, TerminationReason } from './task-status.js';
import type { TokenUsage } from './usage-types.js';
import type { RalphLoopState } from '../shared/contracts/ralph.js';
import type { PlaybookSourceIdentity } from '../shared/contracts/playbook.js';
import type { LaunchPhaseTimings } from './launch-phase-timings.js';
import type { DeliveryAuthorization, TaskDependencyEdge, TaskDisposition, TaskLaunchAdmission, TaskLaunchIntent, TaskLaunchSource, TaskMetadata, TaskPriority, TaskProvenance, TaskRelaunchDisposition, TaskTerminalReceipt } from '../shared/contracts/task.js';

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
  /**
   * Where this launch originated (issue #1583). Drives the immutable
   * {@link Task.provenance} marker: `schedule` ⇒ schedule provenance,
   * anything else ⇒ `manual`. Absent (no declared source, no parent) ⇒
   * `unknown`. Threaded from `LaunchOpts.launchSource`.
   */
  launchSource?: TaskLaunchSource;
  /**
   * scheduleId for a schedule-fired launch (issue #1583), used as the
   * `sourceId` of `schedule` provenance. Only meaningful when
   * `launchSource === 'schedule'`.
   */
  scheduleId?: string;
  agentType?: AgentType;
  /** Explicitly persisted launch settings. Omitted means a new unpinned intent is created. */
  launchIntent?: TaskLaunchIntent;
  /** Pre-worker admission state, present while a dependency parks the task. */
  launchAdmission?: TaskLaunchAdmission;
  name?: string;
  playbookId?: string;
  /** Exact playbook resource used at launch. Optional for legacy task records. */
  playbookSource?: PlaybookSourceIdentity;
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
  /**
   * Cross-agent migration lineage (RFC: rfc-cross-agent-task-migration). Set on
   * a continuation task to record the interrupted task it continues. The
   * reverse link (`migratedToTaskId`) is written on the source separately.
   */
  migratedFromTaskId?: string;
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
  /** Optional for backward compatibility; legacy records have no replay contract. */
  launchIntent?: TaskLaunchIntent;
  /** Pre-worker admission state, present while a dependency parks the task. */
  launchAdmission?: TaskLaunchAdmission;
  playbookId?: string;
  /** Exact playbook resource used at launch. Optional for legacy task records. */
  playbookSource?: PlaybookSourceIdentity;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
  /** Advisory launch diagnostics. Does not affect duplicate detection. */
  launchHealthSummary?: TaskLaunchHealthSummary;
  /** Warning text prepended to the actual launch prompt, but not part of `prompt`. */
  launchNote?: string;
  parentTaskId?: string;
  /**
   * Immutable launch provenance (issue #1583): how this task was created —
   * schedule fire, parent spawn, manual API/UI creation, or unknown. Set once
   * at {@link TaskStore.createTask} and never mutated. Legacy tasks persisted
   * before this field existed read back as `{ kind: 'unknown' }`. Exposed in
   * the tasks API so a rollup query can group output by origin.
   */
  provenance?: TaskProvenance;
  childTaskIds?: string[];
  /**
   * Cross-agent task migration lineage (RFC: rfc-cross-agent-task-migration).
   * On a continuation task, `migratedFromTaskId` points at the interrupted task
   * whose work this task continues under a different agent. On the interrupted
   * source task, `migratedToTaskId` points at the continuation task that took
   * over. The two are set as a pair. Distinct from `parentTaskId` (subtask
   * spawn): migration continues the SAME work under a new agent, it does not
   * fan out a child. `agentType` is never mutated by migration — the source
   * keeps its original agent so cost/outcome ledgers stay truthful; the agent
   * change is recorded as a `task_migrate` hop in the continuation's
   * `metadata.agentSubstitutionChain`.
   */
  migratedFromTaskId?: string;
  migratedToTaskId?: string;
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
   * Why the task was terminated (issue #1664). Recorded alongside `terminatedAt`
   * so a swept cohort is diagnosable and the recovery path can tell a resumable
   * kill (restart/oom/timeout/unknown) from a deliberate one (manual/supervisor).
   * Absent on tasks terminated before this field existed (treated as `unknown`).
   */
  terminationReason?: TerminationReason;
  /**
   * Structured terminal-transition receipt (issue #2847). Stamped at the
   * lifecycle chokepoint ({@link TaskStore.transition}) on EVERY terminal move —
   * completed, terminated, or cancelled — capturing typed reason + initiator,
   * prior state, transition time, restart/recovery correlation, and what became
   * of the work. Unifies the previously scattered `terminationReason` /
   * `completionPath` / `disposition` signals into one queryable record.
   *
   * Absent on tasks persisted before this field existed; the API and diagnostics
   * synthesize an explicit `unknown_legacy` receipt for those rather than
   * guessing a cause (see `projectTerminalReceipt`). Kept as a durable historical
   * record: a reopened task carries its last terminal receipt until it either
   * re-terminates (overwrite) or is exposed (projection gates on current status).
   */
  terminalReceipt?: TaskTerminalReceipt;
  /** Killing OS signal when known (e.g. `SIGKILL`). See issue #1664. */
  terminationSignal?: string;
  /** Short free-text detail about the termination. See issue #1664. */
  terminationDetail?: string;
  /**
   * Retry lineage for a `provider_transient` silent-failure auto-retry (issue
   * #1712). `retryOf` points back to the ORIGINAL failing task in the lineage
   * (never to an intermediate retry), so every retry is attributable to the one
   * fire that first hit the provider error. `retryAttempt` is 1-based (1 for the
   * first retry, 2 for the second); the original fire leaves both absent. The
   * completion path reads `retryAttempt` to enforce the bounded-retry cap.
   */
  retryOf?: string;
  retryAttempt?: number;
  /**
   * Queryable evidence that a pre-session prune/terminate path disposed of this
   * task before its first agent session ever attached (issue #1588). Its
   * presence proves the task was terminated on purpose rather than silently
   * lost, and makes the task an idempotent-replay target so a retried POST with
   * the same idempotency key returns it instead of creating a sibling.
   * Absent on every task that reached a session (the overwhelming majority).
   */
  disposition?: TaskDisposition;
  /** Durable reason an automatic relaunch was rejected at its intent boundary. */
  relaunchDisposition?: TaskRelaunchDisposition;
  /**
   * Per-phase launch instrumentation (issue #1589). Recorded on EVERY launch
   * attempt that reaches the adapter — successful or not — so a failed launch
   * (`launch_timeout`/`launch_error`) is diagnosable without server logs: the
   * {@link LaunchPhaseTimings.incompletePhase} field names the phase that
   * consumed the time. Absent on queued/deduplicated launches (no adapter call)
   * and on historical tasks persisted before this field existed.
   */
  launchPhaseTimings?: LaunchPhaseTimings;
  /**
   * Ralph Wiggum-style iteration loop state. Present only when the task was
   * launched (or upgraded) into Ralph mode. Absence = no loop. See issue #440.
   */
  ralphLoop?: RalphLoopState;
}
