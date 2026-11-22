import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { MergedPrAttribution } from '../core/completion/index.js';
import type { TaskDisposition, TaskReapOutcome } from '../shared/contracts/task.js';
import type { HungTaskLivenessEvidence } from '../core/hung-task-reaper.js';
import {
  DEFAULT_HUNG_SUSPECT_TTL_MS,
  emptyHungSuspectReclaimSkipCounts,
  openPrFailsafeSkipTotal,
  selectExpiredHungSuspectTasks,
  type HungSuspectReclaimCandidateOutcome,
  type HungSuspectReclaimSkipCounts,
} from '../core/hung-suspect-ttl.js';
import { appendDispositionEntry, type DispositionEntry } from '../core/disposition-ledger.js';
import { nowISO } from '../core/interaction-log.js';
import { terminateTask, type LifecycleDeps } from './agent-lifecycle.js';
import { reaperEvidence, describeReaperEvidenceFailure, writeReaperAuditRow } from './bounded-reaper-evidence.js';
import {
  formatReclaimKillLine,
  formatReclaimWarningLine,
  toKilledProcesses,
  type KilledProcess,
  type SessionJob,
} from '../core/long-running-jobs.js';
import { liveSessionIdOf, type SessionJobSnapshotter } from './session-job-snapshot.js';
import type { ReapWarning, ReapWarningCoordinator } from '../core/reap-warning-coordinator.js';
import { appendAuditRow } from '../core/audit-log.js';

/** Default grace (seconds) between the TTL reclaim warning and the close (issue #4241). */
export const DEFAULT_HUNG_SUSPECT_TTL_GRACE_SECONDS = 300;

/**
 * After a terminate fails, the next pass re-warns the task (the failed reap
 * consumed its warning). Inside this window the re-warn writes no audit row and
 * types no parent line, so a wedged task does not flood its parent (#3156
 * pattern).
 */
export const HUNG_SUSPECT_TTL_REWARN_SUPPRESS_MS = 15 * 60_000;
const failedReapAtByCoordinator = new WeakMap<ReapWarningCoordinator, Map<string, number>>();

/** Cap last-pass outcome samples on health (issue #2072 task-id audit). */
const MAX_LAST_OUTCOMES = 16;

/**
 * In-memory snapshot for `/api/health` + `/metrics` (issues #1935 / #2045 /
 * #2072). Process-lifetime cumulative counters — restart zeros them (same
 * trade-off as other in-memory reclaim gauges).
 */
export interface HungSuspectTtlReclaimMetricsSnapshot {
  /** Cumulative hungSuspect tasks terminated by the TTL reclaim since process start. */
  reclaimedTotal: number;
  /**
   * Cumulative candidates the sweep tried to terminate (selected past TTL +
   * clear of fail-safes). Includes terminate races that did not succeed.
   */
  reclaimAttempted: number;
  /** Cumulative successful terminates — equal to {@link reclaimedTotal}. */
  reclaimSucceeded: number;
  /** Skip-reason breakdown for hungSuspect candidates not selected (issue #2045). */
  skippedNoLiveness: number;
  /**
   * Aggregate open-PR fail-safe skips (`confirmed + unknown`) for scraper
   * compat. Prefer {@link skippedOpenPrConfirmed} / {@link skippedOpenPrUnknown}
   * when attributing residual (issue #2228).
   */
  skippedOpenPrFailsafe: number;
  /** Confirmed-open PR hold (`isHoldingOpenPr === true`) — issue #2228. */
  skippedOpenPrConfirmed: number;
  /** Unknown/unwired PR hold (GitHub state lag or predicate omitted) — issue #2228. */
  skippedOpenPrUnknown: number;
  skippedUnderTtl: number;
  /**
   * Legacy #2045 counter. After #2072 the selector no longer permanent-skips
   * human-gated anomalies past TTL; this stays at 0 on new processes.
   */
  skippedExemptAnomaly: number;
  skippedProviderPaused: number;
  /**
   * Supervisors left alone because their next supervision wake is scheduled
   * (issue #4162). Exported on `/api/health`, `/metrics`, doctor and
   * `kookr status` (issue #4171); the per-task outcome also appears in
   * {@link lastOutcomes}.
   */
  skippedSupervisionWakeScheduled: number;
  /**
   * Tasks left alone because they own a live long-running job (older than
   * 10 min, or holding the GPU) and are still under the hold cap (issue #4237).
   */
  skippedLongRunningJob: number;
  /** Last selection pass: how many hungSuspect candidates were considered. */
  lastCandidatesConsidered: number;
  /**
   * Last selection pass: per-candidate outcomes with task ids (issue #2072).
   * Answers why `reclaimAttempted` stayed 0 when `candidatesConsidered>0`.
   * Capped at {@link MAX_LAST_OUTCOMES}.
   */
  lastOutcomes: HungSuspectReclaimCandidateOutcome[];
  /** Last pass: task ids selected for reclaim (terminate attempted). */
  lastAttemptedTaskIds: string[];
  /**
   * Cumulative sweep passes that threw before completing (issue #2897). A
   * selector, attribution, or broadcast rejection is caught at the liveness
   * tick's local boundary so later recovery legs still run; each such failure
   * increments this counter.
   */
  sweepFailuresTotal: number;
  /**
   * Sanitized category of the most recent sweep failure (the error's class
   * name, stripped to `[A-Za-z0-9_]` — never the raw message), or `null` when
   * the last completed pass succeeded. A later successful pass clears this
   * while {@link sweepFailuresTotal} is retained (issue #2897).
   */
  lastFailureCategory: string | null;
  /**
   * Epoch-ms timestamp of the most recent sweep failure, or `null` when a
   * later successful pass cleared the current-error state (issue #2897).
   */
  lastFailureAtMs: number | null;
  /**
   * Cumulative hungSuspect TTL terminate rejections since process start
   * (issue #3251). Distinct from {@link sweepFailuresTotal} (whole-pass
   * throws) and from {@link reclaimedTotal} (successful terminates). A later
   * successful reclaim does not reset this — process-lifetime, like the
   * hung-task reaper's `reapFailedTotal`.
   */
  reclaimFailedTotal: number;
  /**
   * Epoch-ms of the most recent terminate rejection, or `null` if none yet
   * (issue #3251). Not cleared by a later successful reclaim — matching the
   * hung-task reaper's `lastReapFailureAt`.
   */
  lastReclaimFailureAt: number | null;
  /**
   * Sanitized category of the most recent terminate rejection (error class
   * name, same `[A-Za-z0-9_]` / 48-char cap as {@link lastFailureCategory}),
   * or `null` if none yet. Never the raw message. Not cleared by a later
   * successful reclaim.
   */
  lastReclaimFailureCategory: string | null;
}

/** Cap the sanitized failure category so health/metrics stay bounded (issue #2897). */
const MAX_FAILURE_CATEGORY_LEN = 48;

/**
 * Derive a bounded, sanitized failure category from a hungSuspect TTL error
 * (whole-pass sweep throws, issue #2897, and per-task terminate rejects,
 * issue #3251). Uses the error's class name only — never the message — and
 * strips it to `[A-Za-z0-9_]` so no raw exception text reaches health or
 * Prometheus. Falls back to `'unknown'` for a non-Error throw or empty name.
 */
export function classifyHungSuspectSweepFailure(err: unknown): string {
  const rawName =
    err instanceof Error && typeof err.name === 'string' && err.name.length > 0
      ? err.name
      : 'unknown';
  const cleaned = rawName.replace(/[^A-Za-z0-9_]/g, '').slice(0, MAX_FAILURE_CATEGORY_LEN);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Process-lifetime counters for the hungSuspect TTL reclaim (issues #1935 /
 * #2045 / #2072). One instance at bootstrap, threaded into the sweep,
 * `/api/health`, and `/metrics`.
 */
export class HungSuspectTtlReclaimMetrics {
  private reclaimedTotal = 0;
  private reclaimAttempted = 0;
  private skips: HungSuspectReclaimSkipCounts = emptyHungSuspectReclaimSkipCounts();
  private lastCandidatesConsidered = 0;
  private lastOutcomes: HungSuspectReclaimCandidateOutcome[] = [];
  private lastAttemptedTaskIds: string[] = [];
  private sweepFailuresTotal = 0;
  private lastFailureCategory: string | null = null;
  private lastFailureAtMs: number | null = null;
  private reclaimFailedTotal = 0;
  private lastReclaimFailureAt: number | null = null;
  private lastReclaimFailureCategory: string | null = null;

  recordReclaimed(count: number): void {
    if (count > 0) this.reclaimedTotal += count;
  }

  /**
   * Record a sweep pass that threw before completing (issue #2897). Bumps the
   * cumulative failure count and remembers a sanitized category + timestamp for
   * the current-error state. The category is derived from the error's class
   * name only — raw exception text never enters the snapshot.
   */
  recordSweepFailure(err: unknown, atMs: number = Date.now()): void {
    this.sweepFailuresTotal += 1;
    this.lastFailureCategory = classifyHungSuspectSweepFailure(err);
    this.lastFailureAtMs = atMs;
  }

  /**
   * Clear the current-error state after a sweep pass that completed without
   * throwing (issue #2897). The cumulative {@link sweepFailuresTotal} is
   * retained; only the last-failure category + timestamp are reset.
   */
  recordSweepSuccess(): void {
    this.lastFailureCategory = null;
    this.lastFailureAtMs = null;
  }

  recordAttempted(count: number): void {
    if (count > 0) this.reclaimAttempted += count;
  }

  /**
   * Record one per-task terminate rejection (issue #3251). Bumps the
   * cumulative failure count and remembers a sanitized category + timestamp.
   * Does not touch the sweep-level current-error fields ({@link lastFailureCategory}
   * / {@link lastFailureAtMs}) — those stay the whole-pass signal from #2897.
   * A later successful reclaim never resets these.
   */
  recordReclaimFailure(err: unknown, atMs: number = Date.now()): void {
    this.reclaimFailedTotal += 1;
    this.lastReclaimFailureAt = atMs;
    this.lastReclaimFailureCategory = classifyHungSuspectSweepFailure(err);
  }

  /**
   * Accumulate skip-reason counts from one selection pass and remember the
   * candidate denominator + task-id outcomes for the health snapshot.
   */
  recordSelection(selection: {
    candidatesConsidered: number;
    skips: HungSuspectReclaimSkipCounts;
    outcomes?: readonly HungSuspectReclaimCandidateOutcome[];
  }): void {
    this.lastCandidatesConsidered = selection.candidatesConsidered;
    this.skips.skipped_no_liveness += selection.skips.skipped_no_liveness;
    this.skips.skipped_open_pr_confirmed += selection.skips.skipped_open_pr_confirmed;
    this.skips.skipped_open_pr_unknown += selection.skips.skipped_open_pr_unknown;
    this.skips.skipped_under_ttl += selection.skips.skipped_under_ttl;
    this.skips.skipped_exempt_anomaly += selection.skips.skipped_exempt_anomaly;
    this.skips.skipped_provider_paused += selection.skips.skipped_provider_paused;
    this.skips.skipped_supervision_wake_scheduled += selection.skips.skipped_supervision_wake_scheduled;
    this.skips.skipped_long_running_job += selection.skips.skipped_long_running_job;
    const outcomes = selection.outcomes ?? [];
    this.lastOutcomes = outcomes.slice(0, MAX_LAST_OUTCOMES).map((o) => ({ ...o }));
    this.lastAttemptedTaskIds = outcomes
      .filter((o) => o.outcome === 'selected')
      .map((o) => o.taskId)
      .slice(0, MAX_LAST_OUTCOMES);
  }

  getSnapshot(): HungSuspectTtlReclaimMetricsSnapshot {
    return {
      reclaimedTotal: this.reclaimedTotal,
      reclaimAttempted: this.reclaimAttempted,
      reclaimSucceeded: this.reclaimedTotal,
      skippedNoLiveness: this.skips.skipped_no_liveness,
      skippedOpenPrFailsafe: openPrFailsafeSkipTotal(this.skips),
      skippedOpenPrConfirmed: this.skips.skipped_open_pr_confirmed,
      skippedOpenPrUnknown: this.skips.skipped_open_pr_unknown,
      skippedUnderTtl: this.skips.skipped_under_ttl,
      skippedExemptAnomaly: this.skips.skipped_exempt_anomaly,
      skippedProviderPaused: this.skips.skipped_provider_paused,
      skippedSupervisionWakeScheduled: this.skips.skipped_supervision_wake_scheduled,
      skippedLongRunningJob: this.skips.skipped_long_running_job,
      lastCandidatesConsidered: this.lastCandidatesConsidered,
      lastOutcomes: this.lastOutcomes.map((o) => ({ ...o })),
      lastAttemptedTaskIds: [...this.lastAttemptedTaskIds],
      sweepFailuresTotal: this.sweepFailuresTotal,
      lastFailureCategory: this.lastFailureCategory,
      lastFailureAtMs: this.lastFailureAtMs,
      reclaimFailedTotal: this.reclaimFailedTotal,
      lastReclaimFailureAt: this.lastReclaimFailureAt,
      lastReclaimFailureCategory: this.lastReclaimFailureCategory,
    };
  }
}

export interface ReclaimHungSuspectTasksDeps {
  taskStore: TaskStore;
  /** Optional lifecycle context — required for terminate to run; absent ⇒ no-op. */
  lifecycleDeps?: LifecycleDeps;
  /** Path to the shared audit.jsonl log. */
  auditLogPath?: string;
  /**
   * Path to the recovery work-conservation ledger (issue #1540). When
   * absent, no disposition-ledger entry is written (task.disposition still is).
   */
  dispositionLedgerPath?: string;
  /** Optional broadcast for the sweep-summary alert. */
  broadcastToAll?: (msg: ServerMessage) => void;
  /**
   * Precomputed hung-suspect classification — typically the same
   * `resolveTaskAttentionSignals(...).hungSuspect` path health/capacity uses.
   */
  isHungSuspect: (task: Task) => boolean;
  /** Raw liveness timestamps for the task's agent (`Watchdog.getState`). */
  getLiveness: (task: Task) => HungTaskLivenessEvidence | undefined;
  /**
   * Queued attention anomaly type — see `core/hung-suspect-ttl.ts` for the
   * needs_input / permission_blocked reclaim exemption.
   */
  getQueuedAnomalyType?: (task: Task) => string | null | undefined;
  /** Provider billing/quota pause (#1667) — reclaim skips when true. */
  isProviderPaused?: (task: Task) => boolean;
  /**
   * Stranded-PR exemption — see `core/hung-suspect-ttl.ts`. Omitted ⇒ every
   * candidate is treated as a possible PR hold and left alone.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
  /**
   * Supervisor-wake exemption (issue #4162) — see `core/hung-suspect-ttl.ts`.
   * Only `true` exempts; omitted ⇒ no task is exempt on this ground.
   */
  isAwaitingScheduledWake?: (task: Task) => boolean | undefined;
  /**
   * Delivery attribution for needs-human vs obsolete disposition (same as
   * the hung-task reaper's resolveMergedPr). Absent ⇒ plain terminated /
   * needs-human.
   */
  resolveMergedPr?: (task: Task) => MergedPrAttribution | null;
  /**
   * Fallback delivery probe keyed on the task's own session branch (issue
   * #3578). Consulted only when {@link resolveMergedPr} finds nothing, only
   * after the terminate has freed the slot, and bounded by
   * {@link DEFAULT_REAP_DELIVERY_FALLBACK_TIMEOUT_MS}. It changes the
   * disposition label only; it never completes a task.
   */
  resolveMergedPrByBranch?: (task: Task) => Promise<MergedPrAttribution | null>;
  /**
   * Snapshot of the worker jobs under each past-TTL candidate's session
   * (issue #4237). Drives both the long-running-job hold and the record of
   * what a reclaim killed. Omitted ⇒ no hold, nothing recorded.
   */
  snapshotSessionJobs?: SessionJobSnapshotter;
  /**
   * Type one line into a live session (issue #4237), through the
   * choice-dialog guard. Used to tell a reclaimed worker's parent what the
   * reclaim killed. Omitted ⇒ no parent notification.
   */
  sendLineToSession?: (sessionId: string, line: string) => Promise<void>;
  /**
   * Warned phase before the reclaim (issue #4241). When set and the grace is
   * above zero, a selected task is warned first, its parent is told, and it is
   * closed only once the (possibly kept-alive) deadline passes. Omitted ⇒ the
   * selected task is closed on this pass, as before.
   */
  reapWarningCoordinator?: ReapWarningCoordinator;
  /** Live grace (ms) between warning and close. `0` turns the warned phase off. */
  getGraceMs?: () => number;
  /** Whether a live dashboard connection currently has this task selected. */
  isTaskSelectedByAnyConnection?: (taskId: string) => boolean;
  metrics?: Pick<
    HungSuspectTtlReclaimMetrics,
    'recordReclaimed' | 'recordAttempted' | 'recordSelection' | 'recordReclaimFailure'
  >;
}

export interface ReclaimHungSuspectTasksResult {
  reclaimedTaskIds: string[];
  /** Tasks newly warned on this pass (issue #4241). */
  warnedTaskIds?: string[];
  /** Tasks whose warning this pass dropped (issue #4241). */
  clearedWarningTaskIds?: string[];
  /** Selection snapshot from this pass (for tests / residual alerter). */
  selection?: {
    candidatesConsidered: number;
    skips: HungSuspectReclaimSkipCounts;
    selectedCount: number;
    /** Per-candidate outcomes with task ids (issue #2072). */
    outcomes: HungSuspectReclaimCandidateOutcome[];
  };
}

/** Upper bound on the branch-keyed delivery fallback per reaped task (issue #3578). */
export const DEFAULT_REAP_DELIVERY_FALLBACK_TIMEOUT_MS = 15_000;

/**
 * Resolve a reaped task's delivered PR for its disposition label (issue
 * #3578). Shared by the hungSuspect and provider_paused TTL reapers.
 *
 * Tries the in-memory attribution first (`primary`, already evaluated by the
 * caller). When it found nothing, asks the branch-keyed `fallback`, bounded
 * by `timeoutMs`; a throw, timeout, or null all mean "no confirmed delivery",
 * which is exactly the label the reaper recorded before this fallback
 * existed. The result only chooses a label — callers must never use it to
 * complete a task.
 */
export async function resolveReapDeliveredPr(
  task: Task,
  primary: MergedPrAttribution | null,
  fallback: ((task: Task) => Promise<MergedPrAttribution | null>) | undefined,
  opts: { timeoutMs?: number; logPrefix: string },
): Promise<MergedPrAttribution | null> {
  if (primary || !fallback) return primary;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REAP_DELIVERY_FALLBACK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    return (await Promise.race([fallback(task), timeout])) ?? null;
  } catch (err) {
    console.warn(
      `${opts.logPrefix} branch delivery probe failed for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the in-memory delivery attribution without letting a throw abort the
 * reclaim pass (issue #3578). A throw means "no confirmed delivery".
 */
export function readStoreDeliveredPr(
  task: Task,
  resolveMergedPr: ((task: Task) => MergedPrAttribution | null) | undefined,
  logPrefix: string,
): MergedPrAttribution | null {
  try {
    return resolveMergedPr?.(task) ?? null;
  } catch (err) {
    console.warn(
      `${logPrefix} delivery attribution failed for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Build the task.disposition for a hungSuspect TTL reclaim (issue #1935).
 * Reuses the hung-reap outcome vocabulary (`terminated` /
 * `delivered_then_hung`) with reason `hung_suspect_ttl` so audit surfaces can
 * distinguish the short TTL reclaim from the 3h hard reaper.
 */
export function buildHungSuspectTtlDisposition(
  merged: MergedPrAttribution | null | undefined,
  at: string,
  killedProcesses: readonly KilledProcess[] = [],
  warning?: Pick<ReapWarning, 'keptAliveBy'>,
): TaskDisposition {
  const outcome: TaskReapOutcome = merged ? 'delivered_then_hung' : 'terminated';
  const disposition: TaskDisposition = {
    reason: 'hung_suspect_ttl',
    at,
    source: 'hung-suspect-ttl',
    outcome,
  };
  if (merged) {
    disposition.deliveredPr = {
      number: merged.prNumber,
      ...(merged.prUrl ? { url: merged.prUrl } : {}),
    };
    disposition.detail =
      `Delivered PR #${merged.prNumber} before hanging; reclaimed after hungSuspect TTL silence.`;
  } else {
    disposition.detail =
      'Reclaimed after hungSuspect TTL silence with no confirmed delivery — needs human review.';
  }
  if (killedProcesses.length > 0) {
    disposition.killedProcesses = killedProcesses.map((p) => ({ ...p }));
  }
  const keptAlive = describeKeepAlive(warning);
  if (keptAlive) disposition.detail = `${disposition.detail} ${keptAlive}`;
  return disposition;
}

/** `Kept alive by <name> until <iso>: <reason>.`, or undefined when never kept alive. */
export function describeKeepAlive(warning?: Pick<ReapWarning, 'keptAliveBy'>): string | undefined {
  const k = warning?.keptAliveBy;
  if (!k) return undefined;
  return `Kept alive by ${k.actorName} until ${new Date(k.until).toISOString()}: ${k.reason}.`;
}

/**
 * Reclaim hungSuspect tasks past the silence TTL (issue #1935). Runs on the
 * liveness tick, after the finishedAwaitingAck TTL sweep. Soft reclaim:
 * terminates the session (frees the concurrency slot) without force-completing
 * incomplete work. Each reclaimed task gets a first-write-wins disposition.
 * Ancillary evidence is attempted with a bounded wait; failures or saturation
 * are reported in logs and the sweep alert:
 *
 * - `task.disposition` reason `hung_suspect_ttl` (first-write-wins);
 * - an audit.jsonl row, actor `system:hung-suspect-ttl`, when the write succeeds;
 * - a disposition-ledger entry (`obsolete` if delivered, else `needs-human`), when durable.
 *
 * The stranded-PR exemption in `selectExpiredHungSuspectTasks` protects an
 * in-flight `merge_required` delivery; this function only executes what that
 * selector already cleared. One summary alert per sweep (not per task).
 *
 * Skip-reason counters (issue #2045) accumulate every pass so `/api/health`
 * can explain `reclaimedTotal=0` while hungSuspect occupancy stays high.
 * Issue #2072: past-TTL silence selects even when needs_input /
 * permission_blocked is still queued (stuckReason already labels those
 * hung_suspect); open-PR fail-safe and provider pause remain hard bars.
 * Per-pass outcomes carry task ids for audit.
 */
export async function reclaimAgedHungSuspectTasks(
  deps: ReclaimHungSuspectTasksDeps,
  opts: { now?: Date; ttlMs?: number; longRunningJobCapMs?: number } = {},
): Promise<ReclaimHungSuspectTasksResult> {
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return { reclaimedTaskIds: [] };

  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_HUNG_SUSPECT_TTL_MS;
  const tasks = deps.taskStore.viewTasks();
  const sessionJobs = await snapshotPastTtlCandidateJobs(tasks, deps, now.getTime(), ttlMs);
  const selection = selectExpiredHungSuspectTasks(tasks, {
    now,
    ttlMs,
    isHungSuspect: deps.isHungSuspect,
    getLiveness: deps.getLiveness,
    getQueuedAnomalyType: deps.getQueuedAnomalyType,
    isProviderPaused: deps.isProviderPaused,
    isHoldingOpenPr: deps.isHoldingOpenPr,
    isAwaitingScheduledWake: deps.isAwaitingScheduledWake,
    getSessionJobs: (task) => sessionJobs.get(task.id),
    longRunningJobCapMs: opts.longRunningJobCapMs,
  });

  deps.metrics?.recordSelection(selection);

  const reclaimedTaskIds: string[] = [];
  const warnedTaskIds: string[] = [];
  let incompleteEvidenceTasks = 0;
  let timedOutWrites = 0;
  let unattemptedWrites = 0;
  const terminated: Array<{
    task: Task;
    silentForMs: number;
    storeMerged: MergedPrAttribution | null;
    warning?: ReapWarning;
  }> = [];

  // Warned phase (issue #4241). A warning whose task the selector no longer
  // returns (it spoke, gained a hold, or ended) is dropped first.
  const coordinator = deps.reapWarningCoordinator;
  const graceMs = Math.max(0, deps.getGraceMs?.() ?? DEFAULT_HUNG_SUSPECT_TTL_GRACE_SECONDS * 1000);
  const warnedPhase = coordinator !== undefined && graceMs > 0;
  const clearedWarningTaskIds = coordinator
    ? await clearUnselectedWarnings(coordinator, selection.expired, deps, warnedPhase)
    : [];
  const failedReapAt = coordinator ? failedReapAtFor(coordinator) : undefined;
  let attempted = 0;

  for (const { task, silentForMs } of selection.expired) {
    let warning: ReapWarning | undefined;
    if (warnedPhase && coordinator) {
      const advance = coordinator.advance({
        taskId: task.id,
        agentId: liveSessionIdOf(task) ?? task.id,
        silentForMs,
        now: now.getTime(),
        graceMs,
        present: deps.isTaskSelectedByAnyConnection?.(task.id) ?? false,
      });
      if (advance.action === 'wait') continue;
      if (advance.action === 'warn') {
        const lastFailure = failedReapAt?.get(task.id);
        if (lastFailure !== undefined && now.getTime() - lastFailure < HUNG_SUSPECT_TTL_REWARN_SUPPRESS_MS) {
          continue;
        }
        warnedTaskIds.push(task.id);
        await warnHungSuspectTask(task, advance.warning, sessionJobs.get(task.id) ?? [], graceMs, ttlMs, deps);
        continue;
      }
      warning = advance.warning;
    }

    // Attribute delivery BEFORE terminating so a task that already merged its
    // PR is recorded as delivered_then_hung rather than masking delivery.
    const storeMerged = readStoreDeliveredPr(task, deps.resolveMergedPr, '[hung-suspect-ttl]');
    attempted += 1;

    try {
      await terminateTask(task.id, lifecycleDeps, {
        reason: 'timeout',
        detail:
          `hung-suspect-ttl: silent for ${Math.round(silentForMs / 1000)}s ` +
          `(threshold ${Math.round(ttlMs / 1000)}s)`,
      });
    } catch (err) {
      // Terminate rejected: the slot is still held. Count it as a reclaim
      // failure (issue #3251) so residual with reclaimSucceeded=0 can tell
      // "still under TTL" from "terminate keeps throwing." Continue so a
      // later candidate in this pass can still be reclaimed (#3254).
      deps.metrics?.recordReclaimFailure(err, now.getTime());
      if (warning) failedReapAt?.set(task.id, now.getTime());
      console.warn(
        `[hung-suspect-ttl] could not reclaim task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    failedReapAt?.delete(task.id);
    terminated.push({ task, silentForMs, storeMerged, ...(warning ? { warning } : {}) });
  }

  // Count only the tasks this pass tried to terminate: a warned or waiting
  // task is not a reclaim attempt (issue #4241).
  deps.metrics?.recordAttempted(attempted);

  // The in-memory attribution can miss a PR the task really merged (issue
  // #3578, task 02107c4f), so ask GitHub by branch. Every terminate above has
  // already freed its slot, and the probes run concurrently under one bound,
  // so a slow GitHub call never delays another task's reclaim.
  const deliveredPrs = await Promise.all(
    terminated.map(({ task, storeMerged }) =>
      resolveReapDeliveredPr(task, storeMerged, deps.resolveMergedPrByBranch, {
        logPrefix: '[hung-suspect-ttl]',
      })),
  );

  for (const [index, { task, silentForMs, warning }] of terminated.entries()) {
    const merged = deliveredPrs[index] ?? null;
    // Issue #4237: the jobs snapshotted before the terminate are what the
    // process-tree kill took with the agent.
    const killedProcesses = toKilledProcesses(sessionJobs.get(task.id) ?? []);
    const disposition = buildHungSuspectTtlDisposition(merged, now.toISOString(), killedProcesses, warning);
    const outcome = disposition.outcome ?? 'terminated';
    deps.taskStore.setDisposition(task.id, disposition);

    const logPrefix = `[hung-suspect-ttl] task ${task.id}:`;
    const dispositionPersistence = deps.dispositionLedgerPath
      ? await reaperEvidence.write(
          'disposition',
          () => writeHungSuspectDispositionEntry(task.id, disposition, outcome, silentForMs, deps, now, warning),
          logPrefix,
        )
      : 'skipped';

    reclaimedTaskIds.push(task.id);
    console.warn(
      `[hung-suspect-ttl] reclaimed task ${task.id} — hungSuspect silent ${Math.round(silentForMs / 60_000)}m`,
    );

    const auditRow = {
      type: 'task.hungSuspectTtlReclaimed',
      timestamp: nowISO(),
      actor: 'system:hung-suspect-ttl',
      taskId: task.id,
      reason: 'hung_suspect_ttl',
      silentForMs,
      outcome,
      ...(disposition.deliveredPr ? { deliveredPr: disposition.deliveredPr } : {}),
      ...(killedProcesses.length > 0 ? { killedProcesses } : {}),
      ...(warning
        ? {
            warnedAt: warning.warnedAt,
            keptAliveCount: warning.keptAliveCount,
            ...(warning.keptAliveBy ? { keptAliveBy: { ...warning.keptAliveBy } } : {}),
          }
        : {}),
      ttlMs,
      ...(describeReaperEvidenceFailure('disposition', dispositionPersistence)
        ? { dispositionPersistence }
        : {}),
    };
    const auditPersistence = deps.auditLogPath
      ? await reaperEvidence.write('audit', () => writeReaperAuditRow(deps.auditLogPath!, auditRow), logPrefix)
      : 'skipped';
    const statuses = [dispositionPersistence, auditPersistence];
    if (statuses.some((status) => status === 'error' || status === 'timeout' || status === 'busy')) {
      incompleteEvidenceTasks += 1;
    }
    timedOutWrites += statuses.filter((status) => status === 'timeout').length;
    unattemptedWrites += statuses.filter((status) => status === 'busy').length;

    if (killedProcesses.length > 0) {
      await notifyParentOfKilledJobs(task, silentForMs, killedProcesses, deps);
    }
  }

  deps.metrics?.recordReclaimed(reclaimedTaskIds.length);

  if (reclaimedTaskIds.length > 0) {
    deps.broadcastToAll?.({
      type: 'alert',
      agentId: '',
      summary: `Reclaimed ${reclaimedTaskIds.length} hungSuspect task(s) (TTL)`,
      details:
        'These tasks were classified hungSuspect (all liveness channels silent) past ' +
        'hungSuspectTtlMinutes and were terminated to free active concurrency slots. ' +
        'Tasks with no confirmed delivery are marked needs-human; review the disposition ledger.' +
        (incompleteEvidenceTasks > 0
          ? ` Ancillary evidence is incomplete for ${incompleteEvidenceTasks} task(s); check server logs.` +
            (timedOutWrites > 0 ? ` ${timedOutWrites} write(s) timed out; durability unknown.` : '') +
            (unattemptedWrites > 0 ? ` ${unattemptedWrites} write(s) were not attempted while a previous write remained unresolved.` : '')
          : ''),
      severity: 'warning',
    });
  }

  return {
    reclaimedTaskIds,
    warnedTaskIds,
    clearedWarningTaskIds,
    selection: {
      candidatesConsidered: selection.candidatesConsidered,
      skips: selection.skips,
      selectedCount: selection.expired.length,
      outcomes: selection.outcomes,
    },
  };
}

/**
 * Snapshot worker jobs for the candidates the selector may pick: inProgress,
 * no completion_ready, hungSuspect, and silent at least the TTL. Restricting
 * to past-TTL tasks keeps the `/proc` scan off the common tick. Any failure
 * means "no jobs", which is the pre-#4237 behaviour.
 */
async function snapshotPastTtlCandidateJobs(
  tasks: readonly Task[],
  deps: ReclaimHungSuspectTasksDeps,
  nowMs: number,
  ttlMs: number,
): Promise<Map<string, SessionJob[]>> {
  if (!deps.snapshotSessionJobs) return new Map();
  const candidates = tasks.filter((task) => {
    if (task.status !== 'inProgress' || task.pendingSignal?.kind === 'completion_ready') return false;
    if (!deps.isHungSuspect(task)) return false;
    const liveness = deps.getLiveness(task);
    if (!liveness) return false;
    const last = Math.max(liveness.lastHookEventAt, liveness.lastPaneChangeAt, liveness.lastTokenActivityAt);
    return last > 0 && nowMs - last >= ttlMs;
  });
  if (candidates.length === 0) return new Map();
  try {
    return await deps.snapshotSessionJobs(candidates);
  } catch (err) {
    console.warn(
      '[hung-suspect-ttl] session job snapshot failed; reclaiming without the long-running-job hold:',
      err instanceof Error ? err.message : err,
    );
    return new Map();
  }
}

function failedReapAtFor(coordinator: ReapWarningCoordinator): Map<string, number> {
  let map = failedReapAtByCoordinator.get(coordinator);
  if (!map) {
    map = new Map();
    failedReapAtByCoordinator.set(coordinator, map);
  }
  return map;
}

/**
 * Drop every warning whose task this pass did not select (issue #4241): the
 * task spoke, gained a hold (open PR, long job, provider pause) or ended. When
 * the warned phase is off, every warning goes.
 */
async function clearUnselectedWarnings(
  coordinator: ReapWarningCoordinator,
  expired: ReadonlyArray<{ task: Task }>,
  deps: ReclaimHungSuspectTasksDeps,
  warnedPhase: boolean,
): Promise<string[]> {
  const selected = new Set(expired.map(({ task }) => task.id));
  const cleared: string[] = [];
  for (const taskId of coordinator.warnedTaskIds()) {
    if (warnedPhase && selected.has(taskId)) continue;
    const task = deps.taskStore.getTask(taskId);
    const reason = !warnedPhase ? 'disabled' : !task || task.status !== 'inProgress' ? 'gone' : 'recovered';
    if (!coordinator.clear(taskId, reason)) continue;
    cleared.push(taskId);
    failedReapAtFor(coordinator).delete(taskId);
    await appendAuditRow(deps.auditLogPath, {
      type: 'task.hungSuspectTtlReapWarningCleared',
      timestamp: nowISO(),
      actor: 'system:hung-suspect-ttl',
      taskId,
      reason,
    });
  }
  return cleared;
}

/**
 * Record the warning and tell the worker's live parent, with one typed line
 * that names the deadline and the `kookr keep-alive` command (issue #4241).
 */
async function warnHungSuspectTask(
  task: Task,
  warning: ReapWarning,
  jobs: readonly SessionJob[],
  graceMs: number,
  ttlMs: number,
  deps: ReclaimHungSuspectTasksDeps,
): Promise<void> {
  console.warn(
    `[hung-suspect-ttl] warned task ${task.id} — close in ${Math.round(graceMs / 1000)}s ` +
      `unless kept alive (silent ${Math.round(warning.silentForMs / 60_000)}m)`,
  );
  const parentNotified = await notifyParentOfWarning(task, warning, jobs, deps);
  await appendAuditRow(deps.auditLogPath, {
    type: 'task.hungSuspectTtlReapWarned',
    timestamp: nowISO(),
    actor: 'system:hung-suspect-ttl',
    taskId: task.id,
    silentForMs: warning.silentForMs,
    graceMs,
    ttlMs,
    deadlineAt: new Date(warning.deadlineAt).toISOString(),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId, parentNotified } : {}),
  });
}

async function notifyParentOfWarning(
  task: Task,
  warning: ReapWarning,
  jobs: readonly SessionJob[],
  deps: ReclaimHungSuspectTasksDeps,
): Promise<boolean> {
  if (!task.parentTaskId || !deps.sendLineToSession) return false;
  const parent = deps.taskStore.getTask(task.parentTaskId);
  if (!parent || parent.status !== 'inProgress') return false;
  const sessionId = liveSessionIdOf(parent);
  if (!sessionId) return false;
  const line = formatReclaimWarningLine({
    workerName: task.name || task.id,
    taskId: task.id,
    silentForMs: warning.silentForMs,
    deadlineAtMs: warning.deadlineAt,
    jobs,
  });
  try {
    await deps.sendLineToSession(sessionId, line);
    return true;
  } catch (err) {
    console.warn(
      `[hung-suspect-ttl] could not warn parent ${parent.id} about closing ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Tell the reclaimed worker's parent what the reclaim killed (issue #4237),
 * with one typed line. Only a live parent (inProgress, with a live session)
 * is told; any failure is logged and swallowed — the slot is already free.
 */
async function notifyParentOfKilledJobs(
  task: Task,
  silentForMs: number,
  killed: readonly KilledProcess[],
  deps: ReclaimHungSuspectTasksDeps,
): Promise<void> {
  if (!task.parentTaskId || !deps.sendLineToSession) return;
  const parent = deps.taskStore.getTask(task.parentTaskId);
  if (!parent || parent.status !== 'inProgress') return;
  const sessionId = liveSessionIdOf(parent);
  if (!sessionId) return;
  const line = formatReclaimKillLine({ workerName: task.name || task.id, silentForMs, killed });
  try {
    await deps.sendLineToSession(sessionId, line);
  } catch (err) {
    console.warn(
      `[hung-suspect-ttl] could not tell parent ${parent.id} what reclaiming ${task.id} killed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function writeHungSuspectDispositionEntry(
  taskId: string,
  taskDisposition: TaskDisposition,
  outcome: TaskReapOutcome,
  silentForMs: number,
  deps: ReclaimHungSuspectTasksDeps,
  now: Date,
  warning?: ReapWarning,
): Promise<void> {
  if (!deps.dispositionLedgerPath) return;
  const silentMinutes = Math.round(silentForMs / 60_000);
  const killed = taskDisposition.killedProcesses;
  const base: DispositionEntry =
    outcome === 'delivered_then_hung'
      ? {
          schemaVersion: 'disposition-ledger.v1',
          taskId,
          disposition: 'obsolete',
          detail: taskDisposition.deliveredPr
            ? `obsolete-because: delivered PR #${taskDisposition.deliveredPr.number} before hanging; hungSuspect TTL reclaim`
            : 'obsolete-because: delivered its work before hanging; hungSuspect TTL reclaim',
          incidentId: hungSuspectIncidentId(now),
          source: 'hung-suspect-ttl',
          at: now.toISOString(),
        }
      : {
          schemaVersion: 'disposition-ledger.v1',
          taskId,
          disposition: 'needs-human',
          detail:
            `needs-human: hungSuspect TTL reclaimed after ${silentMinutes}m of silence with no confirmed delivery`,
          incidentId: hungSuspectIncidentId(now),
          source: 'hung-suspect-ttl',
          at: now.toISOString(),
        };
  const keptAlive = describeKeepAlive(warning);
  const withKeepAlive: DispositionEntry = keptAlive ? { ...base, detail: `${base.detail}; ${keptAlive}` } : base;
  const entry: DispositionEntry = killed && killed.length > 0
    ? { ...withKeepAlive, killedProcesses: killed.map((p) => ({ ...p })) }
    : withKeepAlive;
  await appendDispositionEntry(deps.dispositionLedgerPath, entry);
}

function hungSuspectIncidentId(now: Date): string {
  return `hung-suspect-ttl-${now.toISOString().slice(0, 10)}`;
}
