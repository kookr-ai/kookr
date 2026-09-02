import type { AgentSelection } from './agent-types.js';
import type { ModelTier } from './model-tier.js';
import type { PlaybookScope } from './playbook.js';
import type { TokenUsage } from './usage.js';
import type { TerminalReasonCategory, TerminalTransitionSource } from './task.js';

export interface SchedulePlaybook {
  path: string;
  parameters: Record<string, string>;
  /**
   * Pinned tier the playbook is resolved from. Optional/additive — absence
   * means the legacy project-tier-only behaviour. Mirrors the `core/schedule`
   * definition (both must carry the field or the types diverge).
   */
  scope?: PlaybookScope;
  /** Catalog cwd used to resolve a project-scoped playbook when task cwd differs. */
  sourceCwd?: string;
}

/**
 * Why a schedule is auto-disabled. Mirrors `core/schedule`.
 * - `trigger_limit_reached` — finite `maxTriggers` budget exhausted.
 * - `consecutive_failures` — fail-closed pause after N consecutive non-success
 *   runs (issue #2353).
 */
export type ScheduleStopReason = 'trigger_limit_reached' | 'consecutive_failures';

/**
 * Provenance of the current {@link Schedule.operatorHold} (issue #2520).
 * `operator` = a human held it (never auto-cleared); `daemon` = an automated
 * fail-closed path (#2353 consecutive-failures auto-pause) held it (eligible
 * for auto-re-arm / bulk recovery). Mirrors `core/schedule`.
 */
export type ScheduleHoldSource = 'operator' | 'daemon';
export type ScheduleExecutionTrigger = 'cron' | 'manual';
export type ScheduleExecutionDecision = 'cron_due' | 'manual_run' | 'catch_up' | 'manual_catch_up' | 'stale_catch_up';
export type ScheduleExecutionOutcome =
  /**
   * @deprecated No longer produced (issue #1526 Phase A) — a capacity-queued
   * fire now records {@link queued_capacity} instead. Kept in the type only
   * so historical ledger rows persisted before this change still render.
   */
  | 'queued'
  /**
   * A schedule fire went through the normal task-submission path and landed
   * as a pending task because the node was at capacity (issue #1526 Phase A
   * / FM8), instead of being dropped as `skipped_capacity`.
   */
  | 'queued_capacity'
  /** Preserved launch intent waiting for a required dependency to recover. */
  | 'parked_dependency'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'deduplicated'
  | 'dispatch_failed'
  | 'skipped_active'
  /**
   * @deprecated No longer produced (issue #1526 Phase A) — a capacity fire
   * now records `queued_capacity` instead of being dropped.
   */
  | 'skipped_capacity'
  | 'skipped_draining'
  /**
   * Pre-stop drain during intentional process restart / redeploy (issue #1983).
   * Distinct from operator `skipped_draining` so the UI can surface a durable
   * "missed due to redeploy" last-miss reason. Mirrors `core/schedule`.
   */
  | 'skipped_server_restarting'
  /**
   * Operator automation kill-switch engaged (issue #1710 / #1699 WS0.4).
   * Schedule fire suppressed while SAFE MODE is on; not a failure.
   */
  | 'skipped_safe_mode'
  | 'skipped_manual'
  | 'skipped_stale'
  /**
   * Coalesced (issue #1526 Phase A): the previous fire's task is still
   * `pending`. Distinct from `skipped_active` (previous run actively
   * running) so at most one outstanding queued fire per schedule exists.
   */
  | 'skipped_coalesced'
  /**
   * Startup catch-up fire withheld by the WS0.5 relaunch arbiter (issue #1900):
   * another actuator holds the schedule's relaunch lease or its post-release
   * backoff window is live. Mirrors `core/schedule`.
   */
  | 'skipped_relaunch_locked'
  /**
   * Pinned schedule agent unavailable with no substitute (issue #1895 /
   * #1699 WS1.3). Fire parked via WS0 provider_paused — not a failure.
   * Mirrors `core/schedule`.
   */
  | 'skipped_provider_paused'
  /**
   * Opt-in fail-closed skip when the playbook cwd checkout lags its upstream
   * (issue #2945). Mirrors `core/schedule`.
   */
  | 'skipped_playbook_drift'
  | 'unknown_after_restart';

export type ScheduleExecutionReasonCode =
  | 'none'
  | 'capacity'
  /** Required launch dependency is confirmed degraded or probe-busy. */
  | 'dependency_degraded'
  | 'draining'
  /**
   * Reason code for `skipped_server_restarting` (issue #1983). Mirrors
   * `core/schedule`.
   */
  | 'server_restarting'
  /** Reason code for `skipped_safe_mode` (issue #1710). */
  | 'safe_mode'
  | 'previous_run_active'
  /** Reason code for `skipped_coalesced`. */
  | 'previous_run_pending'
  | 'manual_catch_up_required'
  | 'missing_cwd'
  | 'missing_playbook'
  | 'validation'
  | 'deduplicated'
  | 'launch_error'
  /** Fire rejected by the pending-queue depth limit (issue #1526 Phase C / C3) — mirrors `core/schedule`. */
  | 'pending_queue_full'
  | 'stale_catch_up'
  /** Reason code for `skipped_relaunch_locked` (issue #1900). Mirrors `core/schedule`. */
  | 'relaunch_lease_held'
  /** Pinned agent substituted to an available agent (issue #1895). Mirrors `core/schedule`. */
  | 'agent_substituted'
  /** Parked fire — no substitute for unavailable pin (issue #1895). Mirrors `core/schedule`. */
  | 'provider_paused'
  /**
   * Grok session/OIDC auth expired/missing with no non-Grok substitute
   * (issue #2194). Mirrors `core/schedule`.
   */
  | 'auth_expired'
  | 'reconciled_after_restart'
  | 'unknown_after_restart'
  /** Cheap probe completed without an agent (issue #2569) — exit 0. */
  | 'probe_quiet'
  /** Cheap probe failed/blipped without an agent (issue #2569) — exit 1. */
  | 'probe_blip'
  /**
   * Reason code for `skipped_playbook_drift` (issue #2945). Mirrors
   * `core/schedule`.
   */
  | 'playbook_cwd_lag';

/**
 * Classified task terminal cause carried onto a schedule execution receipt
 * (issue #2877). Mirrors `core/schedule`. Bounded typed fields copied from the
 * fire's task terminal receipt (#2847) at the task→schedule terminal
 * transition, so a schedule execution row can answer "did this fire time out,
 * fail on the provider, die in a restart, or is it a legacy unknown?" without
 * joining `/api/schedules` back to `/api/tasks`.
 *
 * Deliberately narrow: it copies only the typed classification, the resolved
 * provider/agent type, and the transition timestamp — never a prompt or a raw
 * provider error string. `reasonCode` reuses the task-side
 * {@link TerminalReasonCategory} so `timeout`, `provider_failure`,
 * `server_restart`, `unknown`, and `unknown_legacy` classify identically on both
 * sides.
 */
export interface ScheduleTerminalReason {
  /**
   * Typed WHY category from the task receipt (`timeout`, `provider_failure`,
   * `server_restart`, `unknown`, `unknown_legacy`, …). `unknown_legacy` marks a
   * row whose task predated the task-receipt field (#2847) — kept explicit
   * rather than guessed.
   */
  reasonCode: TerminalReasonCategory;
  /** WHO/WHAT drove the task terminal transition (`watchdog`, `provider_admission`, `restart_recovery`, …). */
  source: TerminalTransitionSource;
  /**
   * Resolved provider/agent type for a `provider_failure`, when known (e.g.
   * `claude-code`, `grok-build`). Omitted for other reasons. Never a prompt or
   * raw error.
   */
  provider?: string;
  /** ISO-8601 timestamp of the task terminal transition. */
  at: string;
}

export interface ScheduleExecutionLedgerEntry {
  id: string;
  scheduleId: string;
  receiptId?: string;
  executionToken?: string;
  trigger: ScheduleExecutionTrigger;
  decision: ScheduleExecutionDecision;
  scheduledFor?: string;
  evaluatedAt: string;
  completedAt?: string;
  taskId?: string;
  blockingTaskId?: string;
  outcome: ScheduleExecutionOutcome;
  reasonCode?: ScheduleExecutionReasonCode;
  message?: string;
  /**
   * Cost/token closeout joined from the fire's task at ledger-write time
   * (issue #1582). Absent when the task carried no `tokenUsage` — never a
   * fabricated zero. Mirrors the `core/schedule` definition.
   */
  tokenUsage?: TokenUsage;
  /**
   * Links to artifacts the fire produced (PR URLs today; extensible to issue
   * URLs / receipt paths), joined from the task's completion digest at
   * ledger-write time (issue #1582). Mirrors the `core/schedule` definition.
   */
  artifacts?: string[];
  /**
   * Classified task terminal cause joined from the fire's task receipt at the
   * terminal transition (issue #2877). Absent on non-terminal rows and on
   * fires that never reached a task (dispatch/skip outcomes). Mirrors the
   * `core/schedule` definition.
   */
  terminalReason?: ScheduleTerminalReason;
  /**
   * Git provenance of the playbook text this fire read (issue #2945). Mirrors
   * `core/schedule`.
   */
  playbookSource?: SchedulePlaybookCheckoutSource;
}

/**
 * Git provenance of the playbook text a fire actually read (issue #2945).
 * Mirrors `core/schedule`.
 */
export interface SchedulePlaybookCheckoutSource {
  ref: string;
  upstreamRef?: string;
  behindBy: number;
  drifted: boolean;
}

export interface ScheduleExecutionReceipt {
  id: string;
  scheduleId: string;
  executionToken: string;
  trigger: ScheduleExecutionTrigger;
  decision: ScheduleExecutionDecision;
  scheduledFor?: string;
  evaluatedAt: string;
  taskId?: string;
  status: 'reserved' | 'accepted' | 'terminal' | 'unknown_after_restart';
  playbookSource?: SchedulePlaybookCheckoutSource;
}

export interface ScheduleLatestExecutionStatus {
  receiptId?: string;
  executionToken: string;
  scheduledFor?: string;
  evaluatedAt: string;
  triggeredAt?: string;
  trigger: ScheduleExecutionTrigger;
  taskId?: string;
  outcome: ScheduleExecutionOutcome;
  reasonCode?: ScheduleExecutionReasonCode;
  message?: string;
  /**
   * Classified task terminal cause for the most recent fire (issue #2877), set
   * alongside a terminal `outcome`. Lets `schedulesPausedByFailure` and the UI
   * surface the last classified reason without a task join. Mirrors
   * `core/schedule`.
   */
  terminalReason?: ScheduleTerminalReason;
  /**
   * Git provenance of the playbook text the most recent fire read (issue
   * #2945). Mirrors `core/schedule`.
   */
  playbookSource?: SchedulePlaybookCheckoutSource;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * Explicit operator hold (issue #2196). When true, critical-schedule recovery
   * re-arm will not re-enable this schedule. Auto-pause (#2353) also sets this;
   * leftover consecutive_failures holds from a transient launch_error /
   * overlap-skip that predates ready may still be lifted (#2459).
   * Mirrors `core/schedule`.
   */
  operatorHold?: boolean;
  /**
   * Provenance of the current {@link operatorHold} (issue #2520). Present only
   * while held. `daemon` = automated fail-closed hold (auto-re-armable);
   * `operator` = human hold (never auto-cleared). Absent on legacy holds
   * (treated as operator-set). Mirrors `core/schedule`.
   */
  holdSource?: ScheduleHoldSource;
  /**
   * ISO timestamp of when the current hold was established (issue #2520). Set
   * alongside {@link operatorHold}; cleared on re-enable. Mirrors `core/schedule`.
   */
  heldAt?: string;
  cron: string;
  maxTriggers?: number;
  remainingTriggers?: number;
  stopReason?: ScheduleStopReason;
  exhaustedAt?: string;
  playbook: SchedulePlaybook;
  cwd: string;
  /**
   * Optional per-schedule agent pin. When omitted, each fire uses the live
   * `settings.defaultAgentType`. Set only to force a concrete agent or
   * `round-robin`.
   */
  agentType?: AgentSelection;
  modelTier?: ModelTier;
  /** Optional per-schedule reasoning-effort pin (#1518). */
  effort?: string;
  /** Optional per-schedule model pin (#1518). */
  model?: string;
  /**
   * Opt-in fail-closed on playbook cwd lag (issue #2945). Default is
   * warn-and-still-launch. Mirrors `core/schedule`.
   */
  failOnPlaybookDrift?: boolean;
  lastRunAt?: string;
  lastRunTaskId?: string;
  /**
   * Coarse status of the most recently recorded fire. Healthy overlap-skips
   * write `skipped` so a leftover `failed` cannot keep looking like the last
   * run failed (issue #2568). Mirrors `core/schedule`.
   */
  lastRunStatus?: 'completed' | 'cancelled' | 'failed' | 'skipped';
  /**
   * Count of consecutive genuine failures (issue #1665). Mirrors the
   * `core/schedule` definition — reset to 0 on a `completed` run, incremented
   * on `dispatch_failed` or a cancelled/timeout run. Overlap-skips do not
   * increment it (issue #2458). Drives the fail-closed auto-pause (issue #2353).
   */
  consecutiveFailures?: number;
  lastScheduledFor?: string;
  lastCronEvaluatedAt?: string;
  latestExecution?: ScheduleLatestExecutionStatus;
  currentExecution?: ScheduleExecutionReceipt;
  executionLedger: ScheduleExecutionLedgerEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `core/schedule` — tri-state playbook resolution health (R9). */
export type PlaybookResolutionState = 'unknown' | 'resolvable' | 'unresolvable';

export interface ScheduleResponse extends Schedule {
  nextRunAt: string | null;
  cronDescription: string;
  /** Cached resolution health; absent on older servers (treat as `unknown`). */
  playbookResolution?: PlaybookResolutionState;
}

export interface ScheduleStatusSnapshot {
  timezone: string;
  runnerStartedAt?: string;
  lastTickCompletedAt?: string;
  catchUpMode: 'auto' | 'manual' | 'off';
  catchUpEnabled: boolean;
  schedulerHealthy: boolean;
  loadError?: string;
  lastError?: string;
  /**
   * Dead-man bounded self-heal counters (issue #1903). Absent when self-heal
   * has never acted. `class: 'auth_expired'` (issue #2195) marks a pure Grok
   * session-auth episode (no self-heal thrash; one escalate).
   */
  deadManSelfHeal?: {
    attempts: number;
    successes: number;
    escalated: boolean;
    class?: 'auth_expired';
  };
  /**
   * Schedules auto-paused after consecutive failures (issue #2353). Absent or
   * empty when none. Mirrors `core/schedule`.
   */
  schedulesPausedByFailure?: Array<{
    id: string;
    name: string;
    consecutiveFailures: number;
    /**
     * Last classified terminal reason that contributed to the fail-closed pause
     * (issue #2877), joined from the schedule's `latestExecution.terminalReason`.
     * Lets recovery logic and operators see WHY a schedule stopped (a timeout
     * storm vs. provider silence vs. legacy unknown) and WHEN, without joining
     * back to `/api/tasks`. Absent on legacy holds with no classified fire.
     */
    lastTerminalReason?: ScheduleTerminalReason;
  }>;
}

export interface ScheduleListResponse {
  revision: number;
  schedules: ScheduleResponse[];
  status: ScheduleStatusSnapshot;
}

/**
 * Materialized per-schedule ROI rollup (issue #1584). Mirrors
 * `core/schedule-rollup` — served by `GET /api/schedules/:id/rollup` and
 * `GET /api/schedules/rollups`, derived incrementally from the execution ledger
 * with no on-request tasks.json / hook-log scan. `costUsd`/`tokens` sum only
 * MEASURED fires (those carrying a joined `tokenUsage`); `measuredFires` is the
 * denominator so an unmeasured fire never reads as a $0 spend.
 */
export interface ScheduleRollup {
  scheduleId: string;
  fires: number;
  outcomes: Partial<Record<ScheduleExecutionOutcome, number>>;
  measuredFires: number;
  costUsd: number;
  tokens: number;
  artifacts: number;
  windowStart?: string;
  windowEnd?: string;
  updatedAt: string;
}
