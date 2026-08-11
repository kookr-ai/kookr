import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { TaskDisposition, TaskReapOutcome } from '../shared/contracts/task.js';
import type { HungTaskLivenessEvidence } from '../core/hung-task-reaper.js';
import {
  DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
  emptyProviderPausedTtlSkipCounts,
  providerPausedOpenPrFailsafeSkipTotal,
  selectExpiredProviderPausedTasks,
  summarizeProviderPausedOccupancy,
  type ProviderPausedOccupancySnapshot,
  type ProviderPausedTtlCandidateOutcome,
  type ProviderPausedTtlSkipCounts,
} from '../core/provider-paused-ttl.js';
import { appendAuditRow } from '../core/audit-log.js';
import { appendDispositionEntry, type DispositionEntry } from '../core/disposition-ledger.js';
import { nowISO } from '../core/interaction-log.js';
import { terminateTask, type LifecycleDeps } from './agent-lifecycle.js';

/** Cap last-pass outcome samples on health (issue #2079 audit). */
const MAX_LAST_OUTCOMES = 16;

/**
 * First-observed continuous pause start per task (issue #2079).
 *
 * Latches `pauseStartedAt` the first time a task is observed provider_paused
 * while inProgress; clears when the task leaves pause or leaves inProgress
 * so a later pause gets a fresh clock. Process-memory only — restart re-latches
 * on the next tick (same trade-off as delivered-completion firstObserved map).
 */
export class ProviderPausedStartTracker {
  private readonly pauseStartedAt = new Map<string, number>();

  /**
   * Observe one task: latch start if paused+inProgress, else clear.
   * Returns the latched start ms when currently paused, else undefined.
   */
  observe(task: Task, isPaused: boolean, nowMs: number): number | undefined {
    if (task.status !== 'inProgress' || task.pendingSignal?.kind === 'completion_ready') {
      this.pauseStartedAt.delete(task.id);
      return undefined;
    }
    if (!isPaused) {
      this.pauseStartedAt.delete(task.id);
      return undefined;
    }
    const existing = this.pauseStartedAt.get(task.id);
    if (existing !== undefined) return existing;
    const start = Number.isFinite(nowMs) ? nowMs : Date.now();
    this.pauseStartedAt.set(task.id, start);
    return start;
  }

  /** Read latched start without mutating (for selection after observe). */
  getPauseStartedAtMs(taskId: string): number | undefined {
    return this.pauseStartedAt.get(taskId);
  }

  /** Drop a task (after reclaim / terminal). */
  clear(taskId: string): void {
    this.pauseStartedAt.delete(taskId);
  }

  /**
   * Sweep all tasks once: latch/clear pause starts, return a getter for
   * selection + occupancy summary on the same pass.
   */
  observeAll(
    tasks: readonly Task[],
    isProviderPaused: (task: Task) => boolean,
    nowMs: number,
  ): (task: Task) => number | undefined {
    const liveIds = new Set<string>();
    for (const task of tasks) {
      liveIds.add(task.id);
      this.observe(task, isProviderPaused(task), nowMs);
    }
    // Drop starts for tasks no longer in the store (completed/pruned elsewhere).
    for (const id of this.pauseStartedAt.keys()) {
      if (!liveIds.has(id)) this.pauseStartedAt.delete(id);
    }
    return (task: Task) => this.getPauseStartedAtMs(task.id);
  }
}

/**
 * In-memory snapshot for `/api/health` + `/metrics` (issue #2079).
 * Process-lifetime cumulative counters — restart zeros them.
 */
export interface ProviderPausedOccupancyMetricsSnapshot {
  /** Live occupancy from the last observe pass. */
  count: number;
  oldestPauseAgeMs: number | null;
  taskIds: string[];
  /** Cumulative hard-TTL terminates since process start. */
  reclaimedTotal: number;
  reclaimAttempted: number;
  reclaimSucceeded: number;
  skippedUnderTtl: number;
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
  skippedNoPauseStart: number;
  skippedAwaitingProviderReset: number;
  lastCandidatesConsidered: number;
  lastOutcomes: ProviderPausedTtlCandidateOutcome[];
  lastAttemptedTaskIds: string[];
  /** Configured hard TTL (ms) last used for selection. */
  hardTtlMs: number;
}

/**
 * Process-lifetime counters + last occupancy for provider_paused bound
 * (issue #2079). One instance at bootstrap, threaded into the sweep,
 * `/api/health`, and `/metrics`.
 */
export class ProviderPausedOccupancyMetrics {
  private reclaimedTotal = 0;
  private reclaimAttempted = 0;
  private skips: ProviderPausedTtlSkipCounts = emptyProviderPausedTtlSkipCounts();
  private lastCandidatesConsidered = 0;
  private lastOutcomes: ProviderPausedTtlCandidateOutcome[] = [];
  private lastAttemptedTaskIds: string[] = [];
  private lastOccupancy: ProviderPausedOccupancySnapshot = {
    count: 0,
    oldestPauseAgeMs: null,
    taskIds: [],
  };
  private hardTtlMs = DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS;

  recordOccupancy(snapshot: ProviderPausedOccupancySnapshot): void {
    this.lastOccupancy = {
      count: snapshot.count,
      oldestPauseAgeMs: snapshot.oldestPauseAgeMs,
      taskIds: [...snapshot.taskIds],
    };
  }

  recordHardTtlMs(ttlMs: number): void {
    if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) {
      this.hardTtlMs = Math.floor(ttlMs);
    }
  }

  recordReclaimed(count: number): void {
    if (count > 0) this.reclaimedTotal += count;
  }

  recordAttempted(count: number): void {
    if (count > 0) this.reclaimAttempted += count;
  }

  recordSelection(selection: {
    candidatesConsidered: number;
    skips: ProviderPausedTtlSkipCounts;
    outcomes?: readonly ProviderPausedTtlCandidateOutcome[];
  }): void {
    this.lastCandidatesConsidered = selection.candidatesConsidered;
    this.skips.skipped_under_ttl += selection.skips.skipped_under_ttl;
    this.skips.skipped_open_pr_confirmed += selection.skips.skipped_open_pr_confirmed;
    this.skips.skipped_open_pr_unknown += selection.skips.skipped_open_pr_unknown;
    this.skips.skipped_no_pause_start += selection.skips.skipped_no_pause_start;
    this.skips.skipped_awaiting_provider_reset +=
      selection.skips.skipped_awaiting_provider_reset;
    const outcomes = selection.outcomes ?? [];
    this.lastOutcomes = outcomes.slice(0, MAX_LAST_OUTCOMES).map((o) => ({ ...o }));
    this.lastAttemptedTaskIds = outcomes
      .filter((o) => o.outcome === 'selected')
      .map((o) => o.taskId)
      .slice(0, MAX_LAST_OUTCOMES);
  }

  getSnapshot(): ProviderPausedOccupancyMetricsSnapshot {
    return {
      count: this.lastOccupancy.count,
      oldestPauseAgeMs: this.lastOccupancy.oldestPauseAgeMs,
      taskIds: [...this.lastOccupancy.taskIds],
      reclaimedTotal: this.reclaimedTotal,
      reclaimAttempted: this.reclaimAttempted,
      reclaimSucceeded: this.reclaimedTotal,
      skippedUnderTtl: this.skips.skipped_under_ttl,
      skippedOpenPrFailsafe: providerPausedOpenPrFailsafeSkipTotal(this.skips),
      skippedOpenPrConfirmed: this.skips.skipped_open_pr_confirmed,
      skippedOpenPrUnknown: this.skips.skipped_open_pr_unknown,
      skippedNoPauseStart: this.skips.skipped_no_pause_start,
      skippedAwaitingProviderReset: this.skips.skipped_awaiting_provider_reset,
      lastCandidatesConsidered: this.lastCandidatesConsidered,
      lastOutcomes: this.lastOutcomes.map((o) => ({ ...o })),
      lastAttemptedTaskIds: [...this.lastAttemptedTaskIds],
      hardTtlMs: this.hardTtlMs,
    };
  }
}

export interface ReclaimProviderPausedTasksDeps {
  taskStore: TaskStore;
  lifecycleDeps?: LifecycleDeps;
  auditLogPath?: string;
  dispositionLedgerPath?: string;
  broadcastToAll?: (msg: ServerMessage) => void;
  isProviderPaused: (task: Task) => boolean;
  /** First-observed pause start tracker (shared across ticks). */
  pauseStartTracker: ProviderPausedStartTracker;
  /**
   * Optional liveness evidence — used so hard-TTL age follows last activity
   * when sticky billing events remain in the event window (issue #2079).
   */
  getLiveness?: (task: Task) => HungTaskLivenessEvidence | undefined;
  /**
   * Provider-reset registration (#1896). Same contract as the hung-task
   * reaper's `recordProviderPause`: returns whether to keep holding for resume.
   * When holdForResume is true, hard-TTL reclaim skips the task so auto-resume
   * can fire at reset; when false (reset elapsed), reclaim proceeds and frees
   * the lease for the scheduled relaunch.
   */
  recordProviderPause?: (
    task: Task,
    detail?: string,
  ) => { holdForResume: boolean } | void;
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
  metrics?: Pick<
    ProviderPausedOccupancyMetrics,
    | 'recordReclaimed'
    | 'recordAttempted'
    | 'recordSelection'
    | 'recordOccupancy'
    | 'recordHardTtlMs'
  >;
}

export interface ReclaimProviderPausedTasksResult {
  reclaimedTaskIds: string[];
  occupancy: ProviderPausedOccupancySnapshot;
  selection?: {
    candidatesConsidered: number;
    skips: ProviderPausedTtlSkipCounts;
    selectedCount: number;
    outcomes: ProviderPausedTtlCandidateOutcome[];
  };
}

/**
 * Build the task.disposition for a provider_paused hard-TTL reclaim (issue #2079).
 * Always needs-human / terminated — never force-complete as delivered.
 */
export function buildProviderPausedTtlDisposition(at: string): TaskDisposition {
  const outcome: TaskReapOutcome = 'terminated';
  return {
    reason: 'provider_paused_ttl',
    at,
    source: 'provider-paused-ttl',
    outcome,
    detail:
      'Reclaimed after provider_paused hard TTL with no auto-complete — needs human review '
      + '(billing/quota hold, not delivered).',
  };
}

/**
 * Observe provider_paused occupancy and hard-TTL reclaim (issue #2079).
 *
 * Soft reclaim: terminates the session (frees the concurrency slot) without
 * force-completing incomplete work. Each reclaimed task gets:
 *
 * - `task.disposition` reason `provider_paused_ttl` (first-write-wins);
 * - an audit.jsonl row, actor `system:provider-paused-ttl`;
 * - a disposition-ledger entry (`needs-human` always).
 *
 * Open-PR fail-safe protects in-flight delivery; this function only executes
 * what the pure selector already cleared. One summary alert per reclaim batch.
 */
export async function reclaimAgedProviderPausedTasks(
  deps: ReclaimProviderPausedTasksDeps,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<ReclaimProviderPausedTasksResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS;
  const tasks = deps.taskStore.listTasks();

  const getPauseStartedAtMs = deps.pauseStartTracker.observeAll(
    tasks,
    deps.isProviderPaused,
    nowMs,
  );

  const occupancy = summarizeProviderPausedOccupancy(tasks, {
    now,
    isProviderPaused: deps.isProviderPaused,
    getPauseStartedAtMs: (task) => getPauseStartedAtMs(task),
  });
  deps.metrics?.recordOccupancy(occupancy);
  deps.metrics?.recordHardTtlMs(ttlMs);

  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) {
    return { reclaimedTaskIds: [], occupancy };
  }

  const selection = selectExpiredProviderPausedTasks(tasks, {
    now,
    ttlMs,
    isProviderPaused: deps.isProviderPaused,
    getPauseStartedAtMs: (task) => getPauseStartedAtMs(task),
    getLastActivityAtMs: (task) => {
      const liveness = deps.getLiveness?.(task);
      if (!liveness) return undefined;
      const last = Math.max(
        liveness.lastHookEventAt,
        liveness.lastPaneChangeAt,
        liveness.lastTokenActivityAt,
      );
      return last > 0 ? last : undefined;
    },
    isAwaitingProviderReset: (task) => {
      if (!deps.recordProviderPause) return false;
      // Production recordProviderPause returns holdForResume:true for tasks
      // with no issueClaim (hung reaper keeps holding forever — no resume to
      // schedule). Hard TTL is the upper bound that frees those slots with
      // needs-human; only skip when a real #1896 resume path can exist.
      if (!task.issueClaim) return false;
      try {
        const decision = deps.recordProviderPause(task, 'provider_paused_ttl');
        return decision?.holdForResume === true;
      } catch (err) {
        // Fail-safe: if registration throws, hold rather than reclaim out
        // from under a possible auto-resume path (#1896).
        console.error(
          `[provider-paused-ttl] recordProviderPause failed for task ${task.id}:`,
          err,
        );
        return true;
      }
    },
    isHoldingOpenPr: deps.isHoldingOpenPr,
  });

  deps.metrics?.recordSelection(selection);
  deps.metrics?.recordAttempted(selection.expired.length);

  const reclaimedTaskIds: string[] = [];
  for (const { task, pausedForMs } of selection.expired) {
    const disposition = buildProviderPausedTtlDisposition(now.toISOString());

    try {
      await terminateTask(task.id, lifecycleDeps, {
        reason: 'timeout',
        detail:
          `provider-paused-ttl: paused for ${Math.round(pausedForMs / 1000)}s `
          + `(threshold ${Math.round(ttlMs / 1000)}s)`,
      });
    } catch (err) {
      console.warn(
        `[provider-paused-ttl] could not reclaim task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    deps.taskStore.setDisposition(task.id, disposition);
    deps.pauseStartTracker.clear(task.id);

    await writeProviderPausedDispositionEntry(task.id, pausedForMs, deps, now).catch(
      (err) => {
        console.error(
          `[provider-paused-ttl] failed to record disposition-ledger entry for task ${task.id}:`,
          err,
        );
      },
    );

    reclaimedTaskIds.push(task.id);
    console.warn(
      `[provider-paused-ttl] reclaimed task ${task.id} — provider_paused ${Math.round(pausedForMs / 60_000)}m`,
    );

    await appendAuditRow(deps.auditLogPath, {
      type: 'task.providerPausedTtlReclaimed',
      timestamp: nowISO(),
      actor: 'system:provider-paused-ttl',
      taskId: task.id,
      reason: 'provider_paused_ttl',
      pausedForMs,
      outcome: 'terminated',
      ttlMs,
    });
  }

  deps.metrics?.recordReclaimed(reclaimedTaskIds.length);

  // Recompute occupancy after reclaim so health reflects freed slots this tick.
  if (reclaimedTaskIds.length > 0) {
    const postTasks = deps.taskStore.listTasks();
    const postOccupancy = summarizeProviderPausedOccupancy(postTasks, {
      now,
      isProviderPaused: deps.isProviderPaused,
      getPauseStartedAtMs: (task) => deps.pauseStartTracker.getPauseStartedAtMs(task.id),
    });
    deps.metrics?.recordOccupancy(postOccupancy);

    deps.broadcastToAll?.({
      type: 'alert',
      agentId: '',
      summary: `Reclaimed ${reclaimedTaskIds.length} provider_paused task(s) (hard TTL)`,
      details:
        'These tasks were provider_paused (billing/quota) past providerPausedHardTtl '
        + 'and were terminated to free active concurrency slots. Disposition is needs-human '
        + '(never auto-completed as delivered). Review the disposition ledger.',
      severity: 'warning',
    });

    return {
      reclaimedTaskIds,
      occupancy: postOccupancy,
      selection: {
        candidatesConsidered: selection.candidatesConsidered,
        skips: selection.skips,
        selectedCount: selection.expired.length,
        outcomes: selection.outcomes,
      },
    };
  }

  return {
    reclaimedTaskIds,
    occupancy,
    selection: {
      candidatesConsidered: selection.candidatesConsidered,
      skips: selection.skips,
      selectedCount: selection.expired.length,
      outcomes: selection.outcomes,
    },
  };
}

async function writeProviderPausedDispositionEntry(
  taskId: string,
  pausedForMs: number,
  deps: ReclaimProviderPausedTasksDeps,
  now: Date,
): Promise<void> {
  if (!deps.dispositionLedgerPath) return;
  const pausedMinutes = Math.round(pausedForMs / 60_000);
  const entry: DispositionEntry = {
    schemaVersion: 'disposition-ledger.v1',
    taskId,
    disposition: 'needs-human',
    detail:
      `needs-human: provider_paused hard TTL reclaimed after ${pausedMinutes}m of billing/quota hold `
      + '(never auto-completed as delivered)',
    incidentId: providerPausedIncidentId(now),
    source: 'provider-paused-ttl',
    at: now.toISOString(),
  };
  await appendDispositionEntry(deps.dispositionLedgerPath, entry);
}

function providerPausedIncidentId(now: Date): string {
  return `provider-paused-ttl-${now.toISOString().slice(0, 10)}`;
}
