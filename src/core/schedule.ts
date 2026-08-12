import { randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSelection } from './agent-types.js';
import { DEFAULT_AGENT_TYPE, normalizeAgentSelection } from './agent-types.js';
import { isValidCron, nextRun, describeCron } from './cron.js';
import type { PlaybookScope } from './playbook.js';
import type { TokenUsage } from './usage-types.js';
import type { LaunchPhaseTimings } from './launch-phase-timings.js';
import { ScheduleRollupStore, type ScheduleRollup } from './schedule-rollup.js';
import { isCriticalAllowlistedSchedule } from './critical-schedule-rearm.js';

export interface SchedulePlaybook {
  path: string;
  parameters: Record<string, string>;
  /**
   * Pinned tier the playbook is resolved from (`project` | `user` | `plugin`).
   * Optional and additive: a schedule with no `scope` (un-migrated legacy)
   * resolves from the project tier only, exactly as before. See
   * rfc-schedule-playbook-resolution R2/R3.
   */
  scope?: PlaybookScope;
  /**
   * When present on the playbook reference, the schedule arms an always-running
   * Ralph loop via `launchLoopedPlaybook` on fire (issue #1899 / #1699 WS2.1).
   * Prefer the top-level {@link Schedule.loop} field; this nested form is
   * accepted for create/update convenience and normalized onto the schedule.
   */
  loop?: ScheduleLoopConfig;
}

/**
 * Always-running (Ralph) loop arming config for a schedule (issue #1899 /
 * #1699 WS2.1). Presence of this object — even as `{}` — routes `fire()`
 * through `launchLoopedPlaybook` instead of a one-shot launch, gated behind
 * the WS0.5 relaunch arbiter so two actuators cannot arm duplicate loops for
 * the same schedule unit. Optional fields are reserved schedule-level
 * overrides of playbook loop defaults; the launcher currently uses the
 * playbook's `effectiveLoop` for the actual iteration budget.
 */
export interface ScheduleLoopConfig {
  iterationCap?: number;
  zeroDiffConsecutiveIterations?: number;
  costCapUsd?: number;
  stopPredicate?: string;
}

/** True when a schedule is configured to arm a Ralph loop on fire (#1899). */
export function hasScheduleLoopConfig(
  schedule: { loop?: ScheduleLoopConfig | null },
): boolean {
  return schedule.loop !== undefined && schedule.loop !== null;
}

/** Coerce a persisted / API loop config blob; drops malformed values. */
export function normalizeScheduleLoopConfig(raw: unknown): ScheduleLoopConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  const out: ScheduleLoopConfig = {};
  if (typeof candidate.iterationCap === 'number' && Number.isInteger(candidate.iterationCap) && candidate.iterationCap > 0) {
    out.iterationCap = candidate.iterationCap;
  }
  if (
    typeof candidate.zeroDiffConsecutiveIterations === 'number'
    && Number.isInteger(candidate.zeroDiffConsecutiveIterations)
    && candidate.zeroDiffConsecutiveIterations > 0
  ) {
    out.zeroDiffConsecutiveIterations = candidate.zeroDiffConsecutiveIterations;
  }
  if (typeof candidate.costCapUsd === 'number' && Number.isFinite(candidate.costCapUsd) && candidate.costCapUsd > 0) {
    out.costCapUsd = candidate.costCapUsd;
  }
  if (typeof candidate.stopPredicate === 'string' && candidate.stopPredicate.length > 0) {
    out.stopPredicate = candidate.stopPredicate;
  }
  // Presence alone is meaningful (empty `{}` arms a loop with playbook defaults).
  return out;
}

/**
 * Why a schedule is auto-disabled.
 * - `trigger_limit_reached` — finite `maxTriggers` budget exhausted.
 * - `consecutive_failures` — fail-closed pause after N consecutive non-success
 *   terminal runs (issue #2353). Cleared when an operator re-enables the
 *   schedule.
 */
export type ScheduleStopReason = 'trigger_limit_reached' | 'consecutive_failures';
export type ScheduleExecutionTrigger = 'cron' | 'manual';
export type ScheduleExecutionDecision = 'cron_due' | 'manual_run' | 'catch_up' | 'manual_catch_up' | 'stale_catch_up';
export type ScheduleExecutionOutcome =
  /**
   * @deprecated No longer produced (issue #1526 Phase A) — a capacity-queued
   * fire now records {@link queued_capacity} instead, which carries the same
   * meaning plus an explicit reason. Kept in the type only so historical
   * ledger rows persisted before this change still deserialize/render.
   */
  | 'queued'
  /**
   * A schedule fire went through the normal task-submission path and landed
   * as a pending task because the node was at capacity (issue #1526 Phase A
   * / FM8). It queues instead of being dropped — the scheduler's promotion
   * loop launches it once a slot frees.
   */
  | 'queued_capacity'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'deduplicated'
  | 'dispatch_failed'
  | 'skipped_active'
  /**
   * @deprecated No longer produced (issue #1526 Phase A) — a capacity fire
   * now goes through the launcher and records `queued_capacity` instead of
   * being dropped. Kept in the type only for historical ledger rows.
   */
  | 'skipped_capacity'
  | 'skipped_draining'
  /**
   * Pre-stop drain during an intentional process restart / redeploy
   * (issue #1983). Distinct from a manual operator drain (`skipped_draining`)
   * so the schedule UI can show "missed due to redeploy" instead of a generic
   * drain. Detected via the short-lived `server-restarting.json` marker that
   * `prod-restart` writes before entering drain.
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
   * `pending` (queued_capacity, not yet launched). Distinct from
   * `skipped_active` (previous run actively running) so at most one
   * outstanding queued fire per schedule ever exists — a second fire is
   * skipped rather than stacking another pending task behind the first.
   */
  | 'skipped_coalesced'
  /**
   * A startup catch-up fire was withheld because the WS0.5 relaunch arbiter
   * denied admission (issue #1900 / #1699 WS2.2): another actuator already
   * holds the schedule's relaunch lease, or the post-release backoff window is
   * still live. Prevents a missed run from duplicating a concurrent relaunch.
   */
  | 'skipped_relaunch_locked'
  /**
   * Pinned schedule agent was unavailable and no substitute could launch
   * (issue #1895 / #1699 WS1.3). Fire is parked via the WS0 provider-paused
   * guard rather than recorded as `dispatch_failed`.
   */
  | 'skipped_provider_paused'
  | 'unknown_after_restart';

export type ScheduleExecutionReasonCode =
  | 'none'
  | 'capacity'
  | 'draining'
  /**
   * Reason code for {@link ScheduleExecutionOutcome.skipped_server_restarting}
   * (issue #1983) — intentional redeploy, not a bare operator drain.
   */
  | 'server_restarting'
  /** Reason code for `skipped_safe_mode` (issue #1710). */
  | 'safe_mode'
  | 'previous_run_active'
  /** Reason code for {@link ScheduleExecutionOutcome.skipped_coalesced}. */
  | 'previous_run_pending'
  | 'manual_catch_up_required'
  | 'missing_cwd'
  | 'missing_playbook'
  | 'validation'
  | 'deduplicated'
  | 'launch_error'
  /**
   * Reason code for a `dispatch_failed` fire rejected by the pending-queue
   * depth limit (issue #1526 Phase C / C3): the node was at capacity AND the
   * pending queue already held `maxPendingTasks` tasks, so queueing the fire
   * was refused. Distinct from generic `launch_error` so schedule ledgers
   * (and the dead-man switch's operator) can see backpressure, not a broken
   * launcher.
   */
  | 'pending_queue_full'
  | 'stale_catch_up'
  /**
   * Reason code for {@link ScheduleExecutionOutcome.skipped_relaunch_locked}
   * (issue #1900): the WS0.5 relaunch arbiter denied the catch-up fire because
   * the schedule's relaunch lease is held or in its post-release backoff.
   */
  | 'relaunch_lease_held'
  /**
   * Pinned agent was unavailable; fire launched on a substitute agent
   * (issue #1895 / #1699 WS1.3). Feeds the WS1.5 provider-health substitution
   * counter and the schedule ledger.
   */
  | 'agent_substituted'
  /**
   * Reason code for {@link ScheduleExecutionOutcome.skipped_provider_paused}
   * (issue #1895): no launchable substitute for an unavailable pin — fire
   * parked rather than dispatched into a known-missing agent.
   */
  | 'provider_paused'
  /**
   * Grok session/OIDC auth is expired or missing, and no non-Grok substitute
   * could launch (issue #2194). Distinct from generic `launch_error` so the
   * ledger/GET /api/schedules surface a readable auth failure instead of a
   * thrashing `dispatch_failed` noise class. Never an API-key path.
   */
  | 'auth_expired'
  | 'reconciled_after_restart'
  | 'unknown_after_restart';

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
   * (issue #1582), so schedule ROI is readable straight off the ledger.
   * Absent when the task carried no `tokenUsage` (e.g. `dispatch_failed`, or a
   * task whose transcript never yielded usage) — never a fabricated zero, so a
   * missing field means "not measured", not "$0 spent".
   */
  tokenUsage?: TokenUsage;
  /**
   * Links to artifacts the fire produced — PR URLs today, extensible to issue
   * URLs / receipt paths — joined from the task's completion digest at
   * ledger-write time (issue #1582). Absent/empty when the task recorded none.
   */
  artifacts?: string[];
  /**
   * Per-phase launch timings for a `dispatch_failed` fire (issue #1589), so a
   * failed launch is diagnosable straight from the ledger without server logs:
   * {@link LaunchPhaseTimings.incompletePhase} names the phase that consumed the
   * time (e.g. the 180s `launch_error` class). Absent on fires that never hit a
   * launch (validation/backpressure rejections) or that succeeded.
   */
  launchPhaseTimings?: LaunchPhaseTimings;
  /**
   * Merge commit SHA of the delivery unit this fire produced (issue #1596),
   * joined from the task's completion digest at ledger-write time. Present only
   * for a fire whose PR MERGED — its absence means "not a merged unit", never a
   * fabricated value. This is the containment key the ROI rollup tests against
   * the last smoke-gate-passed prod SHA to distinguish `merged` from
   * `live-verified` delivery.
   */
  mergeCommit?: string;
}

/**
 * Per-schedule cap on persisted {@link ScheduleExecutionLedgerEntry} rows
 * (issue #1392). A once-per-minute schedule accrues ~1,440 entries/day, held in
 * memory and re-serialized in full on every reservation — unbounded memory and
 * O(ledger) fsync cost on a long-running node. Bounding the ledger to the
 * newest N rows makes both flat.
 *
 * Consequence for the ROI rollup (issue #1584): `computeScheduleRollup` derives
 * from this ledger and is already a WINDOWED view (it carries `windowStart` /
 * `windowEnd`), so the cap simply narrows that window to the retained rows — it
 * does not break a lifetime contract the rollup never made. At 500 the window
 * spans ~8h for a per-minute schedule and is effectively unbounded for the
 * hourly/daily cadences that dominate, while keeping the per-tick serialization
 * cost a constant rather than O(age).
 */
export const MAX_LEDGER_ENTRIES = 500;

/**
 * Outcomes a ledger row can carry while its run is still mid-flight — the
 * server has recorded a reservation/launch but no terminal result yet. A later
 * completion (`recordTaskTerminalOutcome`) or post-restart reconcile
 * (`reconcileOnStartup`) resolves the row in place by `taskId`, so these rows
 * MUST survive pruning even when they fall outside the newest-N window; dropping
 * one would silently lose the receipt the reconcile depends on. Mirrors the
 * mid-flight set `reconcileOnStartup` keys off (issue #1392 / #1526 Phase A).
 */
const PENDING_LEDGER_OUTCOMES: ReadonlySet<ScheduleExecutionOutcome> = new Set([
  'running',
  'queued',
  'queued_capacity',
]);

/**
 * True when a ledger row is still awaiting a terminal outcome — see
 * {@link PENDING_LEDGER_OUTCOMES}.
 */
export function isPendingLedgerEntry(entry: ScheduleExecutionLedgerEntry): boolean {
  return PENDING_LEDGER_OUTCOMES.has(entry.outcome);
}

/**
 * Bound a schedule's execution ledger to {@link MAX_LEDGER_ENTRIES} (issue
 * #1392). Keeps the newest `cap` rows (ledger order is chronological — appends
 * push to the tail, in-place updates preserve position) PLUS any pending/
 * unresolved row that would otherwise be pruned, so a live receipt a later
 * reconcile keys off is never dropped. Chronological order is preserved:
 * surviving pending rows from the pruned prefix stay ahead of the retained
 * tail. A no-op when the ledger is already within the cap.
 */
export function pruneExecutionLedger(
  ledger: ScheduleExecutionLedgerEntry[],
  cap: number = MAX_LEDGER_ENTRIES,
): ScheduleExecutionLedgerEntry[] {
  if (cap < 0 || ledger.length <= cap) return ledger;
  const cutoff = ledger.length - cap;
  const tail = ledger.slice(cutoff);
  const survivingPending = ledger.slice(0, cutoff).filter(isPendingLedgerEntry);
  return survivingPending.length === 0 ? tail : [...survivingPending, ...tail];
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
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * Explicit operator hold (issue #2196). When true, critical-schedule recovery
   * re-arm will not re-enable this schedule after outages/restarts. Set when an
   * operator intentionally parks an allowlisted schedule; cleared when the
   * operator re-enables it. Absent/false means disabled schedules on the
   * critical allowlist may be re-armed on the recovery path.
   */
  operatorHold?: boolean;
  cron: string;
  maxTriggers?: number;
  remainingTriggers?: number;
  stopReason?: ScheduleStopReason;
  exhaustedAt?: string;
  playbook: SchedulePlaybook;
  cwd: string;
  /**
   * Optional per-schedule agent pin. When omitted, each fire resolves the live
   * `settings.defaultAgentType` (server default) so schedules track the operator
   * default without re-editing. Set only to force a concrete agent or
   * `round-robin`.
   */
  agentType?: AgentSelection;
  /**
   * Optional per-schedule reasoning-effort pin (#1518). Forwarded into each
   * spawned task as the launch `effort` (wins over the global per-agent-type
   * default; a per-task override would still win if one were supplied).
   */
  effort?: string;
  /**
   * Optional per-schedule model pin (#1518). Forwarded into each spawned task
   * as the launch `model` (e.g. `claude-fable-5`). No-op when omitted — the
   * agent CLI / env default applies.
   */
  model?: string;
  /**
   * When present, fire() arms an always-running Ralph loop via
   * `launchLoopedPlaybook` instead of a one-shot launch (issue #1899 /
   * #1699 WS2.1). Gated behind the WS0.5 relaunch arbiter so concurrent
   * actuators cannot arm duplicate loops for the same schedule unit.
   * An empty object `{}` is enough — the playbook's `effectiveLoop` supplies
   * iteration budget and stop conditions.
   */
  loop?: ScheduleLoopConfig;
  /** Legacy dispatch fields kept for migration compatibility. */
  lastRunAt?: string;
  lastRunTaskId?: string;
  lastRunStatus?: 'completed' | 'cancelled' | 'failed';
  /**
   * Count of consecutive non-`completed` terminal runs (issue #1665). Bumped
   * whenever `lastRunStatus` is written to anything other than `completed` (a
   * `failed` dispatch/skip outcome or a `cancelled` run) and reset to 0 on a
   * `completed` run. Drives the per-schedule failure alert and the fail-closed
   * auto-pause (issue #2353 — see `ScheduleService`) and surfaces schedule
   * health without hand-reading the store. Absent until the schedule has
   * recorded its first terminal run.
   */
  consecutiveFailures?: number;
  /** Cron watermark — used for cadence computation, not UI status. */
  lastScheduledFor?: string;
  lastCronEvaluatedAt?: string;
  latestExecution?: ScheduleLatestExecutionStatus;
  currentExecution?: ScheduleExecutionReceipt;
  executionLedger: ScheduleExecutionLedgerEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Tri-state playbook resolution health. A cache miss (the window before the
 * first scheduler tick, or right after a cwd/path/scope edit) is `unknown` and
 * renders neutral — never `broken`. See rfc-schedule-playbook-resolution R9.
 */
export type PlaybookResolutionState = 'unknown' | 'resolvable' | 'unresolvable';

/**
 * Cache key for a schedule's resolution health. Includes the inputs that
 * determine resolvability, so a cwd/path/scope edit invalidates the cached
 * value (the stale entry no longer matches → `unknown`).
 */
export function scheduleResolutionSignature(schedule: Pick<Schedule, 'playbook' | 'cwd'>): string {
  const scope = schedule.playbook.scope ?? 'project';
  return [schedule.playbook.path, scope, schedule.cwd].join('\u0000');
}

/** Schedule enriched with computed fields for API responses. */
export interface ScheduleResponse extends Schedule {
  nextRunAt: string | null;
  cronDescription: string;
  /**
   * Cached, off-hot-path playbook resolution health (R9). Computed on the
   * scheduler tick cadence — `enrichSchedule` only reads the cache, never the
   * filesystem. Optional/additive: older servers omit it (treat as `unknown`).
   */
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
   * Dead-man bounded self-heal counters (issue #1903). Absent when self-heal is
   * unconfigured or has never run. `attempts`/`successes` are cumulative;
   * `escalated` is true while the current starvation episode has exhausted the
   * self-heal cap and is standing on a durable alert.
   * `class: 'auth_expired'` (issue #2195) is set while a pure Grok session-auth
   * episode is in flight — self-heal thrash is skipped for that class.
   */
  deadManSelfHeal?: {
    attempts: number;
    successes: number;
    escalated: boolean;
    class?: 'auth_expired';
  };
  /**
   * Schedules currently auto-paused after consecutive failures (issue #2353).
   * Absent or empty when none are parked this way. Surfaced on
   * `GET /api/health` / schedule status so reflection and sentinels can see
   * fail-closed pauses without scanning every schedule row.
   */
  schedulesPausedByFailure?: Array<{
    id: string;
    name: string;
    consecutiveFailures: number;
  }>;
}

export interface ScheduleListResponse {
  revision: number;
  schedules: ScheduleResponse[];
  status: ScheduleStatusSnapshot;
}

export interface CreateScheduleInput {
  name: string;
  cron: string;
  maxTriggers?: number;
  playbook: SchedulePlaybook;
  cwd: string;
  agentType?: AgentSelection;
  /** Optional reasoning-effort pin for every run of this schedule (#1518). */
  effort?: string;
  /** Optional model pin for every run of this schedule (#1518). */
  model?: string;
  /**
   * When present, arms a Ralph loop on fire (issue #1899). May also be
   * supplied nested under `playbook.loop` — both normalize onto `Schedule.loop`.
   */
  loop?: ScheduleLoopConfig;
  enabled?: boolean;
}

export interface UpdateScheduleDefinitionInput {
  name?: string;
  cron?: string;
  maxTriggers?: number | null;
  playbook?: SchedulePlaybook;
  cwd?: string;
  /**
   * Pin a concrete agent / round-robin, or pass `null` to clear a previous pin
   * so the schedule follows the server default again.
   */
  agentType?: AgentSelection | null;
  /** Set to a string to pin; omit to leave unchanged. */
  effort?: string;
  /** Set to a string to pin; omit to leave unchanged. */
  model?: string;
  /**
   * Set to arm loop-on-fire; pass `null` to clear a previously armed loop
   * config (issue #1899). Omit to leave unchanged. Nested `playbook.loop` is
   * also accepted and merges onto the top-level field.
   */
  loop?: ScheduleLoopConfig | null;
}


/**
 * Resolve the agent selection a schedule should launch with.
 * Explicit pin wins; otherwise the live server default (or code default).
 */
export function resolveScheduleAgentSelection(
  schedule: Pick<Schedule, 'agentType'>,
  getDefaultAgentType?: () => AgentSelection,
): AgentSelection {
  return schedule.agentType ?? getDefaultAgentType?.() ?? DEFAULT_AGENT_TYPE;
}

export class ScheduleValidationError extends Error {
  fieldErrors?: Record<string, string>;

  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = 'ScheduleValidationError';
    this.fieldErrors = fieldErrors;
  }
}

export function isValidMaxTriggers(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isTriggerLimitExhausted(schedule: Pick<Schedule, 'maxTriggers' | 'remainingTriggers'>): boolean {
  if (schedule.maxTriggers === undefined) return false;
  return (schedule.remainingTriggers ?? schedule.maxTriggers) <= 0;
}

export class ScheduleStore {
  private schedules = new Map<string, Schedule>();
  private filePath: string;
  private persistChain: Promise<void> = Promise.resolve();
  private revision = 0;
  private loadError?: string;
  /**
   * Off-hot-path resolution-health cache (R9), keyed by schedule id. The
   * scheduler tick writes it; `enrichSchedule` reads it without any FS access.
   * A stale entry (signature mismatch after an edit) reads back as `unknown`.
   */
  private resolutionCache = new Map<string, { signature: string; resolvable: boolean }>();
  /**
   * Durable per-schedule ROI rollup (issue #1584). Materialized incrementally
   * at ledger-write time and reconciled from the ledger on {@link load}, so
   * schedule ROI is readable in O(1) without any on-request scan.
   */
  private rollupStore: ScheduleRollupStore;

  constructor(kookrDir: string) {
    this.filePath = join(kookrDir, 'schedules.json');
    this.rollupStore = new ScheduleRollupStore(kookrDir);
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        for (const raw of data) {
          const schedule = normalizeSchedule(raw);
          if (schedule) {
            this.schedules.set(schedule.id, schedule);
          }
        }
      } else {
        this.loadError = `Unexpected schedule file format: ${this.filePath}`;
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        this.loadError = undefined;
      } else {
        this.loadError = err instanceof Error
          ? `Failed to load schedules: ${err.message}`
          : `Failed to load schedules: ${String(err)}`;
        this.schedules.clear();
      }
    } finally {
      this.bumpRevision();
    }
    // Reconcile the durable rollup against the freshly-loaded ledger — a
    // missing/deleted/corrupt/stale rollup store self-heals from the ledger.
    await this.rollupStore.load(this.list());
  }

  /** Materialized ROI rollup for one schedule (O(1); no ledger scan). */
  getRollup(id: string): ScheduleRollup | undefined {
    return this.rollupStore.get(id);
  }

  /** Materialized ROI rollups for the whole fleet (O(n); no ledger scan). */
  listRollups(): ScheduleRollup[] {
    return this.rollupStore.list();
  }

  /**
   * Record a passed post-deploy smoke gate at `deployedSha` (issue #1596),
   * flipping every merged unit whose merge commit that SHA contains to
   * live-verified. The `isContained` predicate answers "is this merge commit an
   * ancestor of the deployed SHA?" — resolved by the caller via git ancestry,
   * OFF the request path (a deploy event, not a hot-path read). This store owns
   * the schedule ledgers, so it enumerates every merged unit's commit here and
   * hands the resolved live set to the rollup store; a failed smoke gate never
   * calls this, so counts stay unchanged (the failed-deploy invariant).
   */
  async recordDeployVerification(
    deployedSha: string,
    isContained: (mergeCommit: string) => boolean | Promise<boolean>,
  ): Promise<void> {
    // Unique merge commits across the fleet — each tested for containment once.
    const candidates = new Set<string>();
    for (const schedule of this.schedules.values()) {
      for (const entry of schedule.executionLedger) {
        if (entry.mergeCommit) candidates.add(entry.mergeCommit);
      }
    }
    const verified: string[] = [];
    for (const commit of candidates) {
      if (await isContained(commit)) verified.push(commit);
    }
    this.rollupStore.applyDeployVerification(this.list(), deployedSha, verified);
    this.bumpRevision();
  }

  getLoadError(): string | undefined {
    return this.loadError;
  }

  list(): Schedule[] {
    return Array.from(this.schedules.values());
  }

  listWithComputed(): ScheduleResponse[] {
    return this.list().map((s) => enrichSchedule(s, this.resolutionStateFor(s)));
  }

  get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  getWithComputed(id: string): ScheduleResponse | undefined {
    const s = this.schedules.get(id);
    return s ? enrichSchedule(s, this.resolutionStateFor(s)) : undefined;
  }

  /**
   * Record the tick-cadence resolution-health result for a schedule (R9).
   * Called by the scheduler runner; never reads the filesystem here.
   */
  setPlaybookResolution(id: string, signature: string, resolvable: boolean): void {
    this.resolutionCache.set(id, { signature, resolvable });
  }

  private resolutionStateFor(s: Schedule): PlaybookResolutionState {
    const entry = this.resolutionCache.get(s.id);
    if (!entry || entry.signature !== scheduleResolutionSignature(s)) return 'unknown';
    return entry.resolvable ? 'resolvable' : 'unresolvable';
  }

  getRevision(): number {
    return this.revision;
  }

  create(input: CreateScheduleInput): Schedule {
    if (!input.name?.trim()) throw new ScheduleValidationError('name is required', { name: 'Required' });
    if (!isValidCron(input.cron)) throw new ScheduleValidationError('Invalid cron expression', { cron: 'Invalid cron expression' });
    if (input.maxTriggers !== undefined && !isValidMaxTriggers(input.maxTriggers)) {
      throw new ScheduleValidationError('Invalid trigger limit', { maxTriggers: 'Must be a positive integer' });
    }
    if (!input.playbook?.path) throw new ScheduleValidationError('playbook.path is required', { playbook: 'Required' });
    if (!input.cwd?.trim()) throw new ScheduleValidationError('cwd is required', { cwd: 'Required' });

    const now = new Date().toISOString();
    // Accept loop config at the top level or nested under playbook (issue #1899).
    const loop = normalizeScheduleLoopConfig(input.loop ?? input.playbook?.loop);
    const schedule: Schedule = {
      id: randomUUID(),
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      cron: input.cron.trim(),
      ...(input.maxTriggers !== undefined ? {
        maxTriggers: input.maxTriggers,
        remainingTriggers: input.maxTriggers,
      } : {}),
      playbook: {
        path: input.playbook.path,
        parameters: { ...(input.playbook.parameters ?? {}) },
        ...(input.playbook.scope ? { scope: input.playbook.scope } : {}),
      },
      cwd: input.cwd,
      // Omit agentType when unset so fire-time resolves settings.defaultAgentType.
      ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(loop ? { loop } : {}),
      executionLedger: [],
      createdAt: now,
      updatedAt: now,
    };

    this.schedules.set(schedule.id, schedule);
    this.rollupStore.updateFromSchedule(schedule);
    this.bumpRevision();
    return schedule;
  }

  updateDefinition(id: string, patch: UpdateScheduleDefinitionInput): Schedule {
    const existing = this.schedules.get(id);
    if (!existing) throw new ScheduleValidationError(`Schedule not found: ${id}`);

    if (patch.cron !== undefined && !isValidCron(patch.cron)) {
      throw new ScheduleValidationError('Invalid cron expression', { cron: 'Invalid cron expression' });
    }
    if (patch.maxTriggers !== undefined && patch.maxTriggers !== null && !isValidMaxTriggers(patch.maxTriggers)) {
      throw new ScheduleValidationError('Invalid trigger limit', { maxTriggers: 'Must be a positive integer' });
    }

    const { maxTriggers, loop: patchLoop, playbook: patchPlaybook, agentType: patchAgentType, ...rest } = patch;
    const nextTriggerState = computeUpdatedTriggerState(existing, maxTriggers, new Date().toISOString());
    // Loop config update (issue #1899): top-level `null` clears; nested
    // `playbook.loop` is accepted; omit leaves the existing value.
    const nextLoop = resolveUpdatedLoopConfig(patchLoop, patchPlaybook?.loop);
    const updated: Schedule = {
      ...existing,
      ...rest,
      // agentType: null clears the pin (follow server default); string sets it;
      // omit leaves the existing pin. Spreading undefined would not delete the key.
      ...(patchAgentType === null
        ? {}
        : patchAgentType !== undefined
          ? { agentType: patchAgentType }
          : {}),
      ...nextTriggerState,
      ...(patchPlaybook ? {
        playbook: {
          path: patchPlaybook.path,
          parameters: { ...(patchPlaybook.parameters ?? {}) },
          // Merge-carry, never reconstruct-and-drop: an update that omits
          // `scope` preserves the already-pinned tier (R2). Prevents an API
          // client sending only path+parameters from un-pinning a schedule.
          ...((patchPlaybook.scope ?? existing.playbook.scope)
            ? { scope: patchPlaybook.scope ?? existing.playbook.scope }
            : {}),
        },
      } : {}),
      ...(nextLoop !== undefined
        ? (nextLoop === null ? { loop: undefined } : { loop: nextLoop })
        : {}),
      updatedAt: new Date().toISOString(),
    };
    // Explicit clear: spreading `{ loop: undefined }` leaves a key behind on
    // some runtimes; delete so hasScheduleLoopConfig sees absence.
    if (nextLoop === null) {
      delete updated.loop;
    }
    if (patchAgentType === null) {
      delete updated.agentType;
    }
    this.schedules.set(id, updated);
    this.rollupStore.updateFromSchedule(updated);
    this.bumpRevision();
    return updated;
  }

  /**
   * Toggle enabled (issue #2196 hold semantics).
   *
   * - Re-enable: clears {@link Schedule.operatorHold} (operator unparks).
   * - Disable with `operatorHold: true`: park against recovery re-arm.
   * - Disable with `operatorHold: false`: leave re-armable (test/ops escape).
   * - Disable with hold omitted: for **critical allowlisted** schedules, set
   *   hold automatically so UI Pause / CLI disable do not thrash with the
   *   60s recovery re-arm loop; for other schedules, preserve existing hold.
   *   Legacy critical schedules already disabled without a hold remain
   *   re-armable until recovery re-enables them once.
   */
  setEnabled(
    id: string,
    enabled: boolean,
    opts?: { operatorHold?: boolean },
  ): Schedule {
    const existing = this.schedules.get(id);
    if (!existing) throw new ScheduleValidationError(`Schedule not found: ${id}`);
    const updated: Schedule = {
      ...existing,
      enabled,
      updatedAt: new Date().toISOString(),
    };
    if (enabled) {
      // Manual enable clears any hold — the operator is unparking.
      delete updated.operatorHold;
    } else if (opts?.operatorHold === true) {
      updated.operatorHold = true;
    } else if (opts?.operatorHold === false) {
      delete updated.operatorHold;
    } else if (isCriticalAllowlistedSchedule(existing)) {
      // Hold omitted: park critical schedules on intentional disable so UI
      // Pause / CLI disable do not fight recovery re-arm every tick.
      // Non-critical schedules: leave any existing hold state alone.
      updated.operatorHold = true;
    }
    this.schedules.set(id, updated);
    this.rollupStore.updateFromSchedule(updated);
    this.bumpRevision();
    return updated;
  }

  delete(id: string): boolean {
    const deleted = this.schedules.delete(id);
    if (deleted) {
      this.resolutionCache.delete(id);
      this.rollupStore.remove(id);
      this.bumpRevision();
    }
    return deleted;
  }

  replace(schedule: Schedule): void {
    const stored: Schedule = {
      ...schedule,
      updatedAt: new Date().toISOString(),
    };
    this.schedules.set(schedule.id, stored);
    // Incremental, bounded write-path update: recompute only THIS schedule's
    // rollup from its ledger — never a full-fleet rescan (issue #1584).
    this.rollupStore.updateFromSchedule(stored);
    this.bumpRevision();
  }

  async persist(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await this.writeSchedules();
      // Persist the derived rollup alongside the ledger so it survives a
      // restart. It is always reconciled against the ledger on load, so a
      // failed/partial rollup write self-heals on next boot.
      await this.rollupStore.persist();
    });
    // Keep the internal tail usable after a failed write, while callers still observe this write's rejection.
    this.persistChain = write.catch(() => {});
    return write;
  }

  private async writeSchedules(): Promise<void> {
    // Compact JSON — persist is on a hot path (every replace/update chains here).
    // Load still accepts pretty-printed legacy files via JSON.parse (#2217).
    const data = JSON.stringify(this.list());
    const tmpPath = join(dirname(this.filePath), `.schedules-${randomUUID()}.tmp`);
    await mkdir(dirname(this.filePath), { recursive: true });
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(data, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }

  private bumpRevision(): void {
    this.revision += 1;
  }
}

function normalizeSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<Schedule>;
  if (!candidate.id || !candidate.cron || !candidate.playbook?.path || !candidate.cwd) {
    return null;
  }

  const normalized: Schedule = {
    id: String(candidate.id),
    name: typeof candidate.name === 'string' ? candidate.name : 'Unnamed schedule',
    enabled: candidate.enabled ?? true,
    // Durable operator hold (issue #2196) — only rehydrate explicit true.
    ...(candidate.operatorHold === true ? { operatorHold: true } : {}),
    cron: String(candidate.cron),
    ...normalizeTriggerState(candidate),
    playbook: {
      path: String(candidate.playbook.path),
      parameters: { ...(candidate.playbook.parameters ?? {}) },
      // Carry an already-persisted scope through normalization so it survives
      // a reload (R2). Preserved as-is (even an unrecognised value) so the
      // resolver — not normalization — decides resolvability.
      ...(typeof candidate.playbook.scope === 'string'
        ? { scope: candidate.playbook.scope as PlaybookScope }
        : {}),
    },
    cwd: String(candidate.cwd),
    // Preserve absence: do not rehydrate missing agentType to DEFAULT_AGENT_TYPE
    // so schedules can inherit the live server default at fire time.
    ...(typeof candidate.agentType === 'string' && candidate.agentType.trim() !== ''
      ? { agentType: normalizeAgentSelection(candidate.agentType) }
      : {}),
    ...(typeof candidate.effort === 'string' ? { effort: candidate.effort } : {}),
    ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    // Carry a persisted loop config so schedule-armed Ralph loops survive
    // reload (issue #1899). Nested playbook.loop is also accepted for legacy
    // writes that stored it under the playbook reference.
    ...(() => {
      const loop = normalizeScheduleLoopConfig(
        candidate.loop ?? (candidate.playbook as SchedulePlaybook | undefined)?.loop,
      );
      return loop ? { loop } : {};
    })(),
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    ...(typeof candidate.lastRunAt === 'string' ? { lastRunAt: candidate.lastRunAt } : {}),
    ...(typeof candidate.lastRunTaskId === 'string' ? { lastRunTaskId: candidate.lastRunTaskId } : {}),
    ...(candidate.lastRunStatus ? { lastRunStatus: candidate.lastRunStatus } : {}),
    ...(typeof candidate.consecutiveFailures === 'number'
      && Number.isFinite(candidate.consecutiveFailures)
      && candidate.consecutiveFailures > 0
      ? { consecutiveFailures: Math.floor(candidate.consecutiveFailures) }
      : {}),
    ...(typeof candidate.lastScheduledFor === 'string' ? { lastScheduledFor: candidate.lastScheduledFor } : {}),
    ...(typeof candidate.lastCronEvaluatedAt === 'string' ? { lastCronEvaluatedAt: candidate.lastCronEvaluatedAt } : {}),
    ...(candidate.latestExecution ? { latestExecution: normalizeLatestExecution(candidate.latestExecution) } : {}),
    ...(candidate.currentExecution ? { currentExecution: normalizeCurrentExecution(candidate.currentExecution) } : {}),
    executionLedger: normalizeExecutionLedger(candidate.executionLedger),
  };

  return normalized;
}

function normalizeExecutionLedger(raw: unknown): ScheduleExecutionLedgerEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw.flatMap((item) => {
    const entry = normalizeExecutionLedgerEntry(item);
    return entry ? [entry] : [];
  });
  // Bound a legacy ledger that grew unbounded before the cap existed (issue
  // #1392) — a node loading an oversized schedules.json converges to the cap on
  // first read rather than carrying the bloat forward.
  return pruneExecutionLedger(entries);
}

function normalizeExecutionLedgerEntry(raw: unknown): ScheduleExecutionLedgerEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ScheduleExecutionLedgerEntry>;
  if (
    !candidate.id
    || !candidate.scheduleId
    || !candidate.trigger
    || !candidate.decision
    || !candidate.evaluatedAt
    || !candidate.outcome
  ) {
    return undefined;
  }
  // Optional enrichment (issue #1582). Legacy ledgers predate these fields, so
  // both must load cleanly when absent and be dropped rather than trusted when
  // malformed — no migration, no fabricated cost.
  const tokenUsage = normalizeLedgerTokenUsage(candidate.tokenUsage);
  const artifacts = normalizeLedgerArtifacts(candidate.artifacts);
  const mergeCommit = typeof candidate.mergeCommit === 'string' && candidate.mergeCommit.length > 0
    ? candidate.mergeCommit
    : undefined;
  return {
    id: String(candidate.id),
    scheduleId: String(candidate.scheduleId),
    trigger: candidate.trigger,
    decision: candidate.decision,
    evaluatedAt: candidate.evaluatedAt,
    outcome: candidate.outcome,
    ...(candidate.receiptId ? { receiptId: candidate.receiptId } : {}),
    ...(candidate.executionToken ? { executionToken: candidate.executionToken } : {}),
    ...(candidate.scheduledFor ? { scheduledFor: candidate.scheduledFor } : {}),
    ...(candidate.completedAt ? { completedAt: candidate.completedAt } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
    ...(candidate.blockingTaskId ? { blockingTaskId: candidate.blockingTaskId } : {}),
    ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
    ...(candidate.message ? { message: candidate.message } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(mergeCommit ? { mergeCommit } : {}),
  };
}

/**
 * Coerce a persisted ledger `tokenUsage` blob (issue #1582). Returns undefined
 * unless every required numeric field is present and numeric — a partial or
 * malformed record is dropped, never patched with zeros that would read as a
 * measured $0 cost.
 */
function normalizeLedgerTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<TokenUsage>;
  if (
    typeof c.inputTokens !== 'number'
    || typeof c.outputTokens !== 'number'
    || typeof c.cacheReadTokens !== 'number'
    || typeof c.cacheWriteTokens !== 'number'
    || typeof c.costUsd !== 'number'
  ) {
    return undefined;
  }
  return {
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheReadTokens: c.cacheReadTokens,
    cacheWriteTokens: c.cacheWriteTokens,
    costUsd: c.costUsd,
    ...(c.provider === 'openai' || c.provider === 'anthropic' ? { provider: c.provider } : {}),
    ...(typeof c.model === 'string' ? { model: c.model } : {}),
    ...(c.pricingQuality === 'exact' || c.pricingQuality === 'fallback' ? { pricingQuality: c.pricingQuality } : {}),
  };
}

/**
 * Coerce a persisted ledger `artifacts` list (issue #1582). Keeps only
 * non-empty strings; returns undefined when nothing survives so the field
 * stays absent rather than an empty array.
 */
function normalizeLedgerArtifacts(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const artifacts = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return artifacts.length > 0 ? artifacts : undefined;
}

function normalizeLatestExecution(raw: unknown): ScheduleLatestExecutionStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ScheduleLatestExecutionStatus>;
  if (!candidate.executionToken || !candidate.evaluatedAt || !candidate.trigger || !candidate.outcome) {
    return undefined;
  }
  return {
    executionToken: candidate.executionToken,
    evaluatedAt: candidate.evaluatedAt,
    trigger: candidate.trigger,
    outcome: candidate.outcome,
    ...(candidate.receiptId ? { receiptId: candidate.receiptId } : {}),
    ...(candidate.scheduledFor ? { scheduledFor: candidate.scheduledFor } : {}),
    ...(candidate.triggeredAt ? { triggeredAt: candidate.triggeredAt } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
    ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
    ...(candidate.message ? { message: candidate.message } : {}),
  };
}

function normalizeCurrentExecution(raw: unknown): ScheduleExecutionReceipt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ScheduleExecutionReceipt>;
  if (!candidate.id || !candidate.executionToken || !candidate.scheduleId || !candidate.trigger || !candidate.evaluatedAt || !candidate.status) {
    return undefined;
  }
  return {
    id: candidate.id,
    executionToken: candidate.executionToken,
    scheduleId: candidate.scheduleId,
    trigger: candidate.trigger,
    decision: candidate.decision ?? (candidate.trigger === 'manual' ? 'manual_run' : 'cron_due'),
    evaluatedAt: candidate.evaluatedAt,
    status: candidate.status,
    ...(candidate.scheduledFor ? { scheduledFor: candidate.scheduledFor } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
  };
}

function normalizeStopReason(value: unknown): ScheduleStopReason | undefined {
  if (value === 'trigger_limit_reached' || value === 'consecutive_failures') return value;
  return undefined;
}

function normalizeTriggerState(candidate: Partial<Schedule>): Pick<Schedule, 'maxTriggers' | 'remainingTriggers' | 'stopReason' | 'exhaustedAt'> {
  const maxTriggers = isValidMaxTriggers(candidate.maxTriggers) ? candidate.maxTriggers : undefined;
  const stopReason = normalizeStopReason(candidate.stopReason);
  // consecutive_failures pause is independent of a trigger budget (issue #2353)
  // — preserve it even when maxTriggers is absent so a reload does not re-arm
  // a fail-closed schedule.
  if (maxTriggers === undefined) {
    if (stopReason === 'consecutive_failures') {
      return {
        maxTriggers: undefined,
        remainingTriggers: undefined,
        stopReason: 'consecutive_failures',
        exhaustedAt: undefined,
      };
    }
    return {
      maxTriggers: undefined,
      remainingTriggers: undefined,
      stopReason: undefined,
      exhaustedAt: undefined,
    };
  }

  const remainingTriggers = isValidRemainingTriggers(candidate.remainingTriggers)
    ? Math.min(candidate.remainingTriggers, maxTriggers)
    : maxTriggers;
  return {
    maxTriggers,
    remainingTriggers,
    // Prefer an explicit consecutive_failures pause over trigger-limit markers.
    stopReason: stopReason === 'consecutive_failures'
      ? 'consecutive_failures'
      : stopReason === 'trigger_limit_reached'
        ? 'trigger_limit_reached'
        : undefined,
    exhaustedAt: typeof candidate.exhaustedAt === 'string' ? candidate.exhaustedAt : undefined,
  };
}

function isValidRemainingTriggers(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * True when the schedule was auto-disabled by hitting its trigger budget.
 * Exhaustion markers are the only auto-exhaust signal (no separate operator flag);
 * either marker alone counts so partial persisted state still re-arms.
 *
 * A consecutive-failure pause (issue #2353) is NEVER treated as budget
 * exhaustion: operator re-enable via setEnabled is the only recovery path.
 * Without this guard, raising/clearing maxTriggers would re-arm a thrashing
 * schedule that still holds consecutiveFailures ≥ threshold.
 */
function wasAutoExhausted(existing: Pick<Schedule, 'stopReason' | 'exhaustedAt'>): boolean {
  if (existing.stopReason === 'consecutive_failures') return false;
  return existing.stopReason === 'trigger_limit_reached' || existing.exhaustedAt !== undefined;
}

/**
 * Resolve the next loop config for an update (issue #1899).
 * - top-level `null` → clear (`null` sentinel for the caller)
 * - top-level object → replace
 * - nested `playbook.loop` only → replace (same as top-level)
 * - both omitted → leave unchanged (`undefined`)
 */
function resolveUpdatedLoopConfig(
  patchLoop: ScheduleLoopConfig | null | undefined,
  nestedLoop: ScheduleLoopConfig | undefined,
): ScheduleLoopConfig | null | undefined {
  if (patchLoop === null) return null;
  if (patchLoop !== undefined) {
    return normalizeScheduleLoopConfig(patchLoop) ?? {};
  }
  if (nestedLoop !== undefined) {
    return normalizeScheduleLoopConfig(nestedLoop) ?? {};
  }
  return undefined; // leave unchanged
}

function computeUpdatedTriggerState(
  existing: Schedule,
  nextMaxTriggers: number | null | undefined,
  now: string,
): Pick<Schedule, 'maxTriggers' | 'remainingTriggers' | 'stopReason' | 'exhaustedAt'> & Partial<Pick<Schedule, 'enabled'>> {
  if (nextMaxTriggers === undefined) {
    return {
      maxTriggers: existing.maxTriggers,
      remainingTriggers: existing.remainingTriggers,
      stopReason: existing.stopReason,
      exhaustedAt: existing.exhaustedAt,
    };
  }

  // Preserve a consecutive-failure pause across budget edits (issue #2353).
  const failurePaused = existing.stopReason === 'consecutive_failures';

  if (nextMaxTriggers === null) {
    // Unlimited budget — re-enable only if previously auto-exhausted (not
    // operator-disabled and not fail-closed-paused).
    return {
      maxTriggers: undefined,
      remainingTriggers: undefined,
      stopReason: failurePaused ? 'consecutive_failures' : undefined,
      exhaustedAt: undefined,
      ...(wasAutoExhausted(existing) ? { enabled: true } : {}),
    };
  }

  const consumed = existing.maxTriggers === undefined
    ? 0
    : Math.max(existing.maxTriggers - (existing.remainingTriggers ?? existing.maxTriggers), 0);
  const remainingTriggers = Math.max(nextMaxTriggers - consumed, 0);
  if (remainingTriggers === 0) {
    return {
      maxTriggers: nextMaxTriggers,
      remainingTriggers,
      // Failure pause wins over budget exhaustion for stopReason; exhaustedAt
      // still records the budget hit so wasAutoExhausted stays accurate once
      // the operator re-enables and clears the failure pause.
      stopReason: failurePaused ? 'consecutive_failures' : 'trigger_limit_reached',
      exhaustedAt: existing.exhaustedAt ?? now,
      enabled: false,
    };
  }

  // Fresh budget — re-enable only if previously auto-exhausted (not
  // operator-disabled and not fail-closed-paused).
  return {
    maxTriggers: nextMaxTriggers,
    remainingTriggers,
    stopReason: failurePaused ? 'consecutive_failures' : undefined,
    exhaustedAt: undefined,
    ...(wasAutoExhausted(existing) ? { enabled: true } : {}),
  };
}

/** Enrich a schedule with computed nextRunAt, cronDescription and cached health. */
function enrichSchedule(
  s: Schedule,
  playbookResolution: PlaybookResolutionState = 'unknown',
): ScheduleResponse {
  const after = s.lastScheduledFor ? new Date(s.lastScheduledFor) : new Date(s.createdAt);
  const next = s.enabled && !isTriggerLimitExhausted(s) ? nextRun(s.cron, after) : null;
  const effectiveNext = next && next.getTime() <= Date.now()
    ? nextRun(s.cron, new Date())
    : next;
  return {
    ...s,
    nextRunAt: effectiveNext?.toISOString() ?? null,
    cronDescription: describeCron(s.cron),
    playbookResolution,
  };
}
