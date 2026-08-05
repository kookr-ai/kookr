import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { MergedPrAttribution } from '../core/completion/index.js';
import type { TaskDisposition, TaskReapOutcome } from '../shared/contracts/task.js';
import type { HungTaskLivenessEvidence } from '../core/hung-task-reaper.js';
import {
  DEFAULT_HUNG_SUSPECT_TTL_MS,
  emptyHungSuspectReclaimSkipCounts,
  selectExpiredHungSuspectTasks,
  type HungSuspectReclaimCandidateOutcome,
  type HungSuspectReclaimSkipCounts,
} from '../core/hung-suspect-ttl.js';
import { appendAuditRow } from '../core/audit-log.js';
import { appendDispositionEntry, type DispositionEntry } from '../core/disposition-ledger.js';
import { nowISO } from '../core/interaction-log.js';
import { terminateTask, type LifecycleDeps } from './agent-lifecycle.js';

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
  skippedOpenPrFailsafe: number;
  skippedUnderTtl: number;
  /**
   * Legacy #2045 counter. After #2072 the selector no longer permanent-skips
   * human-gated anomalies past TTL; this stays at 0 on new processes.
   */
  skippedExemptAnomaly: number;
  skippedProviderPaused: number;
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

  recordReclaimed(count: number): void {
    if (count > 0) this.reclaimedTotal += count;
  }

  recordAttempted(count: number): void {
    if (count > 0) this.reclaimAttempted += count;
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
    this.skips.skipped_open_pr_failsafe += selection.skips.skipped_open_pr_failsafe;
    this.skips.skipped_under_ttl += selection.skips.skipped_under_ttl;
    this.skips.skipped_exempt_anomaly += selection.skips.skipped_exempt_anomaly;
    this.skips.skipped_provider_paused += selection.skips.skipped_provider_paused;
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
      skippedOpenPrFailsafe: this.skips.skipped_open_pr_failsafe,
      skippedUnderTtl: this.skips.skipped_under_ttl,
      skippedExemptAnomaly: this.skips.skipped_exempt_anomaly,
      skippedProviderPaused: this.skips.skipped_provider_paused,
      lastCandidatesConsidered: this.lastCandidatesConsidered,
      lastOutcomes: this.lastOutcomes.map((o) => ({ ...o })),
      lastAttemptedTaskIds: [...this.lastAttemptedTaskIds],
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
   * Delivery attribution for needs-human vs obsolete disposition (same as
   * the hung-task reaper's resolveMergedPr). Absent ⇒ plain terminated /
   * needs-human.
   */
  resolveMergedPr?: (task: Task) => MergedPrAttribution | null;
  metrics?: Pick<
    HungSuspectTtlReclaimMetrics,
    'recordReclaimed' | 'recordAttempted' | 'recordSelection'
  >;
}

export interface ReclaimHungSuspectTasksResult {
  reclaimedTaskIds: string[];
  /** Selection snapshot from this pass (for tests / residual alerter). */
  selection?: {
    candidatesConsidered: number;
    skips: HungSuspectReclaimSkipCounts;
    selectedCount: number;
    /** Per-candidate outcomes with task ids (issue #2072). */
    outcomes: HungSuspectReclaimCandidateOutcome[];
  };
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
  return disposition;
}

/**
 * Reclaim hungSuspect tasks past the silence TTL (issue #1935). Runs on the
 * liveness tick, after the finishedAwaitingAck TTL sweep. Soft reclaim:
 * terminates the session (frees the concurrency slot) without force-completing
 * incomplete work. Each reclaimed task gets:
 *
 * - `task.disposition` reason `hung_suspect_ttl` (first-write-wins);
 * - an audit.jsonl row, actor `system:hung-suspect-ttl`;
 * - a disposition-ledger entry (`obsolete` if delivered, else `needs-human`).
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
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<ReclaimHungSuspectTasksResult> {
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return { reclaimedTaskIds: [] };

  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_HUNG_SUSPECT_TTL_MS;
  const selection = selectExpiredHungSuspectTasks(deps.taskStore.listTasks(), {
    now,
    ttlMs,
    isHungSuspect: deps.isHungSuspect,
    getLiveness: deps.getLiveness,
    getQueuedAnomalyType: deps.getQueuedAnomalyType,
    isProviderPaused: deps.isProviderPaused,
    isHoldingOpenPr: deps.isHoldingOpenPr,
  });

  deps.metrics?.recordSelection(selection);
  deps.metrics?.recordAttempted(selection.expired.length);

  const reclaimedTaskIds: string[] = [];
  for (const { task, silentForMs } of selection.expired) {
    // Attribute delivery BEFORE terminating so a task that already merged its
    // PR is recorded as delivered_then_hung rather than masking delivery.
    const merged = deps.resolveMergedPr?.(task) ?? null;
    const disposition = buildHungSuspectTtlDisposition(merged, now.toISOString());
    const outcome = disposition.outcome ?? 'terminated';

    try {
      await terminateTask(task.id, lifecycleDeps, {
        reason: 'timeout',
        detail:
          `hung-suspect-ttl: silent for ${Math.round(silentForMs / 1000)}s ` +
          `(threshold ${Math.round(ttlMs / 1000)}s)`,
      });
    } catch (err) {
      // Raced a manual complete/terminate — skip; the task is no longer hungSuspect.
      console.warn(
        `[hung-suspect-ttl] could not reclaim task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    deps.taskStore.setDisposition(task.id, disposition);

    await writeHungSuspectDispositionEntry(task.id, disposition, outcome, silentForMs, deps, now).catch(
      (err) => {
        console.error(
          `[hung-suspect-ttl] failed to record disposition-ledger entry for task ${task.id}:`,
          err,
        );
      },
    );

    reclaimedTaskIds.push(task.id);
    console.warn(
      `[hung-suspect-ttl] reclaimed task ${task.id} — hungSuspect silent ${Math.round(silentForMs / 60_000)}m`,
    );

    await appendAuditRow(deps.auditLogPath, {
      type: 'task.hungSuspectTtlReclaimed',
      timestamp: nowISO(),
      actor: 'system:hung-suspect-ttl',
      taskId: task.id,
      reason: 'hung_suspect_ttl',
      silentForMs,
      outcome,
      ...(disposition.deliveredPr ? { deliveredPr: disposition.deliveredPr } : {}),
      ttlMs,
    });
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
        'Tasks with no confirmed delivery are marked needs-human; review the disposition ledger.',
      severity: 'warning',
    });
  }

  return {
    reclaimedTaskIds,
    selection: {
      candidatesConsidered: selection.candidatesConsidered,
      skips: selection.skips,
      selectedCount: selection.expired.length,
      outcomes: selection.outcomes,
    },
  };
}

async function writeHungSuspectDispositionEntry(
  taskId: string,
  taskDisposition: TaskDisposition,
  outcome: TaskReapOutcome,
  silentForMs: number,
  deps: ReclaimHungSuspectTasksDeps,
  now: Date,
): Promise<void> {
  if (!deps.dispositionLedgerPath) return;
  const silentMinutes = Math.round(silentForMs / 60_000);
  const entry: DispositionEntry =
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
  await appendDispositionEntry(deps.dispositionLedgerPath, entry);
}

function hungSuspectIncidentId(now: Date): string {
  return `hung-suspect-ttl-${now.toISOString().slice(0, 10)}`;
}
