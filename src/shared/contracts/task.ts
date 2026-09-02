import type { RalphLoopState } from './ralph.js';
import type { AgentType } from './agent-types.js';
import type { LaunchDependency } from './playbook.js';
import type { TaskStatus } from './task-status.js';
import type { ModelTier } from './model-tier.js';

export type AutomaticRelaunchSource =
  | 'crash-recovery'
  | 'provider-transient-retry'
  | 'provider-reset'
  | 'ralph'
  | 'pending-promotion';

export type TaskRelaunchDispositionReason = 'missing_launch_intent' | 'malformed_launch_intent';

/** Durable evidence that an automatic relaunch was deliberately not attempted. */
export interface TaskRelaunchDisposition {
  outcome: 'not_relaunched';
  reason: TaskRelaunchDispositionReason;
  source: AutomaticRelaunchSource;
  at: string;
  detail: string;
}

export type TaskDependencyEdge = `task:${string}` | `milestone:${string}`;
export type TaskMetadataIntent = 'keep_as_duplicate';

/**
 * Where a launch originated (issue #1526 Phase C / C3 extends the original
 * log-provenance union with `websocket` and `schedule`). Single source of
 * truth for `LaunchOpts.launchSource`, the per-source spawn budget's bucket
 * key, and the `metadata.launchSource` stamp on the created task record.
 *
 * `idle-refinery` (issue #2144) and `post-recovery` (issue #2899) are autonomous
 * spawn sources: the former decomposes an open umbrella into vetted leaf issues
 * when the harness is idle, the latter refills the queue with a recovery idea
 * scout after an outage/restart returns free capacity to an empty queue. Both
 * are spawn-budget-capped (NOT exempt like `schedule`) and count as autonomous
 * actuation for the kill-switch.
 */
export type TaskLaunchSource =
  | 'cli'
  | 'ui'
  | 'api'
  | 'websocket'
  | 'schedule'
  | 'idle-refinery'
  | 'post-recovery'
  | 'remote-chat-telegram'
  | 'remote-relay';
export type TaskPriority = 'high';
export type TaskPriorityUpdate = TaskPriority | 'normal';

/**
 * How a task was launched (issue #1583). A first-class, immutable provenance
 * marker set at creation so rollups can attribute output (merged PRs, tokens)
 * back to its origin:
 *  - `schedule`: fired by the schedule runner. `sourceId` is the scheduleId.
 *  - `parent`: spawned by another task (incl. the `kookr-spawn-child-task`
 *    HTTP path that forwards `KOOKR_PARENT_TASK_ID`). `sourceId` is the parent
 *    task id.
 *  - `manual`: a plain API/UI/CLI/websocket/remote creation. `sourceId` is the
 *    launcher identity (the {@link TaskLaunchSource}). This covers the six
 *    07-26 'Parallel Issue Batch' tasks (API-created, no schedule, no parent).
 *  - `unknown`: legacy tasks persisted before this field existed, defaulted at
 *    read time, and any creation path that supplied no launch signal.
 */
export type TaskProvenanceKind = 'schedule' | 'manual' | 'parent' | 'unknown';

export interface TaskProvenance {
  kind: TaskProvenanceKind;
  /**
   * Origin identifier the {@link kind} points at: scheduleId for `schedule`,
   * parent task id for `parent`, launcher identity ({@link TaskLaunchSource})
   * for `manual`. Absent for `unknown` and for a `schedule` fire that carried
   * no scheduleId.
   */
  sourceId?: string;
}
// Kept in lockstep with `DeliveryPolicy` in server/worktree-guardrails.ts —
// launch-service assigns one to the other directly. Add any new value to both.
export type DeliveryAuthorization = 'pre-authorized' | 'ask-first' | 'self-advancing';

export interface TaskLaunchPermissionPosture {
  bypassAllPermissions: true;
  mode: 'bypass-all';
  capturedAt: string;
}

/**
 * One hop in an agent substitution / rotation chain (issue #2001).
 * Schedule WS1.3 and plan-quota admission (#1936) each append a hop so the
 * task record and schedule ledger show the full path (e.g. grok→claude then
 * claude→codex) instead of only the first hop.
 */
export type AgentSubstitutionReason = 'schedule_sub' | 'quota_rotate' | 'task_migrate';

export interface AgentSubstitutionHop {
  reason: AgentSubstitutionReason;
  from: AgentType;
  to: AgentType;
}

export interface TaskMetadata {
  intent?: TaskMetadataIntent;
  /**
   * Marks a parent-linked task as an attended, user-initiated retry rather
   * than an autonomous child spawn. The parent link still drives lineage and
   * relation projections, but autonomous parent policy is not inherited.
   */
  userInitiatedRelaunch?: true;
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
  /**
   * Full agent substitution chain for this launch (issue #2001). Empty/absent
   * when the requested agent launched unchanged. Each hop records why it
   * happened (`schedule_sub` or `quota_rotate`) so receipts match reality.
   */
  agentSubstitutionChain?: AgentSubstitutionHop[];
}

/**
 * The immutable launch request retained while admission parks a task.
 * Keeping this separate from the rendered task prompt means a parked task can
 * be retried without losing operator intent or creating a new idempotency
 * identity (issue #2841).
 */
export interface TaskLaunchIntent {
  /** Versioned replay contract used by automatic relaunch paths. */
  schemaVersion: 'task-launch-intent.v1';
  /** Original caller-authored prompt, before Kookr guardrails are injected. */
  prompt?: string;
  /** Requested repository/work directory. */
  cwd?: string;
  /** Normalized repository identity, when one was available at launch time. */
  projectId?: string;
  agentType: AgentType;
  /** Portable model policy retained alongside its resolved concrete pins. */
  modelTier?: ModelTier;
  effort?: string;
  model?: string;
  /** Preserve Ralph iteration-0 verdict wiring across deferred promotion. */
  ralphVerdictEnv?: boolean;
  dependencies?: LaunchDependency[];
  idempotencyKey?: string;
}

export type LaunchDependencyState = 'healthy' | 'degraded' | 'unknown' | 'half_open';

export interface TaskLaunchAdmissionDependency {
  dependency: string;
  state: LaunchDependencyState;
  reason?: string;
}

/** Durable admission state for dependency-gated launches (issue #2841). */
export type TaskLaunchAdmission =
  | {
      status: 'parked';
      reason: 'dependency_degraded' | 'half_open_probe_busy' | 'half_open_waiting_for_capacity';
      dependencies: TaskLaunchAdmissionDependency[];
      parkedAt: string;
    }
  | {
      status: 'probing';
      reason: 'half_open_probe_in_flight';
      dependencies: TaskLaunchAdmissionDependency[];
      startedAt: string;
      /** Preallocated terminal id used to reap a crash-window worker on boot. */
      sessionId?: string;
    };

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
  | 'stale_open_launch'
  /**
   * The hung-task reaper terminated a silent in-session task (issue #1559).
   * Unlike the pre-session reasons above, this disposition is recorded AFTER a
   * session ran; its {@link TaskDisposition.outcome} distinguishes a task that
   * produced nothing from one that had already delivered a merged PR.
   */
  | 'hung_reap'
  /**
   * The hungSuspect TTL reclaim terminated a capacity-class hungSuspect task
   * after the short silence TTL (issue #1935). Same post-session outcome
   * vocabulary as {@link hung_reap}, but sourced from the capacity reclaim
   * path (default ~25m) rather than the hard 3h hung-task reaper.
   */
  | 'hung_suspect_ttl'
  /**
   * The first-hook miss reaper terminated a post-spawn session that never
   * emitted SessionStart / any agent hook within the ack deadline (issue
   * #2036). Distinct from {@link launch_timeout} (pre-session adapter race)
   * and from {@link hung_reap} / {@link hung_suspect_ttl} (post-ack silence).
   */
  | 'first_hook_miss'
  /**
   * The provider_paused hard-TTL reclaim terminated a billing/quota-paused
   * task after the continuous-pause TTL (issue #2079). Always needs-human —
   * never force-completed as delivered. Open-PR fail-safe skips reclaim when
   * the task still holds an unmerged PR (same contract as hungSuspect TTL).
   */
  | 'provider_paused_ttl';

/**
 * Outcome of a hung-task reap (issue #1559). A reaped task's `status` is always
 * `terminated`, but `delivered_then_hung` marks the case where the task had
 * already delivered its work (an attributable merged PR) before it hung — so
 * surfaces can distinguish a successful-but-abandoned delivery from a task that
 * accomplished nothing, instead of masking both as a plain `terminated`.
 */
export type TaskReapOutcome = 'terminated' | 'delivered_then_hung';

/**
 * Queryable disposition record for a task prune/terminate.
 *
 * Two producers write this SAME shape (there is deliberately no second,
 * parallel disposition mechanism — issue #1559):
 * - the pre-session prune/terminate paths (issue #1588: `launch_timeout`,
 *   `launch_error`, `stale_open_launch`), and
 * - the hung-task reaper (issue #1559: `hung_reap`), which additionally sets
 *   {@link outcome} and, on delivery, {@link deliveredPr}, and
 * - the hungSuspect TTL reclaim (issue #1935: `hung_suspect_ttl`), same
 *   outcome vocabulary at the shorter capacity-reclaim TTL, and
 * - the first-hook miss reaper (issue #2036: `first_hook_miss`), for
 *   post-spawn sessions that never acked with a hook, and
 * - the provider_paused hard-TTL reclaim (issue #2079: `provider_paused_ttl`),
 *   which always records needs-human (never delivered auto-complete).
 *
 * The recovery work-conservation ledger (#1540) is expected to build ITS
 * disposition records on this same shape rather than a parallel one.
 */
export interface TaskDisposition {
  /** Why the task was pruned/terminated. */
  reason: TaskDispositionReason;
  /** ISO-8601 timestamp the disposition was recorded. */
  at: string;
  /** Subsystem that recorded it (e.g. 'launch-service', 'startup-reconcile', 'hung-task-reaper'). */
  source: string;
  /** Optional human-readable detail (e.g. the underlying launch error message). */
  detail?: string;
  /**
   * Reap outcome (issue #1559 / #1935). Present on `hung_reap` and
   * `hung_suspect_ttl` dispositions; `delivered_then_hung` when the reaped
   * task had an attributable merged PR.
   */
  outcome?: TaskReapOutcome;
  /**
   * The attributable merged PR that made the outcome `delivered_then_hung`
   * (issue #1559). Sourced from the same delivery attribution the
   * delivered-completion sweep uses (#1560). Absent for a plain `terminated`
   * reap.
   */
  deliveredPr?: {
    number: number;
    url?: string;
  };
}

/**
 * Pre-session dispositions: the task record exists but no agent session ever
 * attached. A starvation/post-recovery scout with one of these reasons must
 * not count as "a scout already ran" (issue #2744).
 */
export const PRE_SESSION_DISPOSITION_REASONS = [
  'launch_timeout',
  'launch_error',
  'stale_open_launch',
] as const satisfies readonly TaskDispositionReason[];

/**
 * True when the task died before a live session attached (`launch_error`,
 * `launch_timeout`, or `stale_open_launch`).
 */
export function isTerminatedAtLaunch(task: {
  disposition?: Pick<TaskDisposition, 'reason'> | null;
}): boolean {
  const reason = task.disposition?.reason;
  if (reason === undefined) return false;
  return (PRE_SESSION_DISPOSITION_REASONS as readonly TaskDispositionReason[]).includes(reason);
}

/**
 * Structured terminal-transition receipt (issue #2847).
 *
 * Before this, a task that ended non-successfully exposed only scattered,
 * path-specific fields — `terminationReason` (terminated-only),
 * `completionPath` (completed-only), `disposition` (prune/reap-only) — so an
 * operator could not answer "who ended this task, why, and what became of the
 * work?" from one read. Layer-3 reflection had to reconstruct that from
 * timestamps and task names. The receipt records that answer once, at the
 * lifecycle chokepoint (`TaskStore.transition`), for EVERY terminal move
 * (completed / terminated / cancelled).
 *
 * It is additive and backward-compatible: a task persisted before this field
 * existed reads back with no receipt, and the API/diagnostics classify such
 * rows as {@link TerminalReasonCategory} `unknown_legacy` rather than inventing
 * a cause. See {@link projectTerminalReceipt}.
 */
export interface TaskTerminalReceipt {
  /** Terminal status this receipt was stamped for. */
  status: 'completed' | 'terminated' | 'cancelled';
  /**
   * Typed WHY category. Never empty for a new receipt (`unknown` when the path
   * genuinely could not classify it). `unknown_legacy` is reserved for rows
   * synthesized at read time from a task that predates this field.
   */
  reason: TerminalReasonCategory;
  /**
   * WHO/WHAT drove the transition (initiator/path). `unknown` for a new
   * transition whose caller supplied no source; `unknown_legacy` only for the
   * synthesized legacy projection.
   */
  source: TerminalTransitionSource;
  /** ISO-8601 timestamp of the terminal transition. */
  at: string;
  /**
   * Lifecycle state immediately before this terminal transition. Absent only
   * on the synthesized legacy projection, which cannot know the prior state.
   */
  priorState?: TaskStatus;
  /**
   * Correlated restart/recovery identifier when this transition belongs to a
   * restart or crash-recovery batch (the server restart epoch). Lets a cohort
   * of restart-terminated tasks be grouped and told apart from unrelated churn.
   */
  recoveryCorrelationId?: string;
  /**
   * What became of the work. `relaunched`/`recovered`/`superseded`/`abandoned`
   * are set by the crash-recovery correlation pass; `completed` marks
   * terminal-complete; `unknown` when not yet determined.
   */
  workDisposition: TerminalWorkDisposition;
  /** Short operator-facing detail about the transition. */
  detail?: string;
  /**
   * Set when a paired terminal-bookkeeping step (persistence flush, ledger or
   * interaction-log append) failed AFTER the transition. Physical cleanup is
   * never blocked on bookkeeping (issue #2847 AC): the original {@link reason}
   * is preserved and the bookkeeping failure is recorded here, separately, so a
   * write hiccup can never masquerade as the cause of termination.
   */
  bookkeepingError?: string;
}

/**
 * Typed category of why a task reached a terminal status. Spans all three
 * terminal outcomes (completed / terminated / cancelled), unlike
 * {@link TerminationReason} which only classifies `terminated`.
 */
export type TerminalReasonCategory =
  | 'completed_normal' // finished through the normal completion path
  | 'completed_recovery' // completed by boot reconcile (clean-finish evidence)
  | 'server_restart' // launcher died with the previous process (boot sweep)
  | 'timeout' // reaped for exceeding a silence/hang threshold
  | 'oom' // killed by the out-of-memory killer
  | 'provider_failure' // provider/transport terminal error (provider_transient)
  | 'launch_failure' // died before a session attached (launch_timeout/error)
  | 'manual' // deliberately cancelled/terminated by an operator
  | 'supervisor' // swept by a supervisor/batch/schedule controller
  | 'unknown' // terminal, cause not classifiable by the transition
  | 'unknown_legacy'; // synthesized for a row that predates the receipt

/**
 * Who/what drove a terminal transition (the initiator/path from issue #2847).
 */
export type TerminalTransitionSource =
  | 'user' // operator via API / UI / CLI / websocket
  | 'watchdog' // hung/silence reaper, TTL reclaim, force-reap
  | 'restart_recovery' // boot reconcile / crash-recovery
  | 'provider_admission' // provider admission gate rejected/killed the launch
  | 'schedule' // schedule/sentinel runner
  | 'task_self' // the task's own agent (self-signal, outbox drain, session death)
  | 'supervisor' // supervisor/batch controller
  | 'unknown' // new transition with no declared source
  | 'unknown_legacy'; // synthesized for a row that predates the receipt

/** What became of a task's work after it went terminal. */
export type TerminalWorkDisposition =
  | 'completed' // the work finished (terminal-complete)
  | 'relaunched' // re-spawned by crash-recovery
  | 'recovered' // resumed/continued elsewhere
  | 'superseded' // demonstrably covered by another live/duplicate task
  | 'abandoned' // no continuation; work not conserved
  | 'unknown'; // not yet determined

/**
 * Caller-supplied provenance for a terminal transition. Every field is
 * optional; {@link TaskStore.transition} fills sensible per-status defaults for
 * anything omitted so a legacy call site still yields a non-empty typed
 * receipt.
 */
export interface TerminalTransitionContext {
  source?: TerminalTransitionSource;
  reason?: TerminalReasonCategory;
  recoveryCorrelationId?: string;
  workDisposition?: TerminalWorkDisposition;
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
