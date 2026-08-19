import type { RalphLoopState } from './ralph.js';
import type { AgentType } from './agent-types.js';

export type TaskDependencyEdge = `task:${string}` | `milestone:${string}`;
export type TaskMetadataIntent = 'keep_as_duplicate';

/**
 * Where a launch originated (issue #1526 Phase C / C3 extends the original
 * log-provenance union with `websocket` and `schedule`). Single source of
 * truth for `LaunchOpts.launchSource`, the per-source spawn budget's bucket
 * key, and the `metadata.launchSource` stamp on the created task record.
 *
 * `idle-refinery` (issue #2144) is the idle-slot idea refinery's autonomous
 * spawn source: it decomposes an open umbrella into vetted leaf issues when the
 * harness is idle. It is spawn-budget-capped (NOT exempt like `schedule`) and
 * counts as autonomous actuation for the kill-switch.
 */
export type TaskLaunchSource =
  | 'cli'
  | 'ui'
  | 'api'
  | 'websocket'
  | 'schedule'
  | 'idle-refinery'
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
