import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { completeTask, type LifecycleDeps } from './agent-lifecycle.js';
import {
  selectExpiredFinishedAwaitingAckTasks,
  listMetaFinishedAwaitingAckAutoCompleteTasks,
  emptyFinishedAwaitingAckReclaimSkipCounts,
  finishedAwaitingAckOpenPrFailsafeSkipTotal,
  taskHasLiveTurn,
  DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS,
  DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS,
  type FinishedAwaitingAckReclaimCandidateOutcome,
  type FinishedAwaitingAckReclaimSkipCounts,
} from '../core/finished-awaiting-ack-ttl.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import { analyzePaneSemantics } from '../shared/pane-semantics.js';

/** Cap last-pass outcome samples on health (issue #2084 task-id audit). */
const MAX_LAST_OUTCOMES = 16;

/** Age histogram buckets (ms) for meta FAA auto-complete + pressure reclaim (issues #2070 / #2355). */
export const META_FAA_AUTO_COMPLETE_AGE_BUCKETS_MS = [
  5 * 60_000,
  12 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
] as const;

/** In-memory snapshot for `/metrics` + `/api/health` (issues #1884 / #2070 / #2084 / #2355). */
export interface FinishedAwaitingAckTtlReclaimMetricsSnapshot {
  /** Cumulative finishedAwaitingAck tasks force-completed by the strict TTL reclaim since process start. */
  reclaimedTotal: number;
  /**
   * Cumulative candidates the sweep tried to force-complete (selected past TTL
   * + clear of fail-safes). Includes complete races that did not succeed.
   */
  reclaimAttempted: number;
  /** Cumulative successful force-completes — equal to {@link reclaimedTotal}. */
  reclaimSucceeded: number;
  /**
   * Cumulative successful reclaim under capacity-pressure soft TTL (issue #2355).
   * Subset of {@link reclaimedTotal}; hard-path reclaim does not increment this.
   */
  capacityPressureEarlyReclaimedTotal: number;
  /** Skip-reason breakdown for finishedAwaitingAck candidates not selected (issue #2084). */
  skippedBadRaisedAt: number;
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
  /** Last selection pass: how many finishedAwaitingAck candidates were considered. */
  lastCandidatesConsidered: number;
  /**
   * Last selection pass: per-candidate outcomes with task ids (issue #2084).
   * Answers why residual FAA stays high when `reclaimedTotal` is flat.
   * Capped at {@link MAX_LAST_OUTCOMES}.
   */
  lastOutcomes: FinishedAwaitingAckReclaimCandidateOutcome[];
  /** Last pass: task ids selected for reclaim (complete attempted). */
  lastAttemptedTaskIds: string[];
  /**
   * Cumulative meta/playbook FAA tasks auto-completed by the #2070 path
   * (allowlist + relaxed PR fail-safe + TOCTOU).
   */
  autoCompletedTotal: number;
  /** Cumulative TOCTOU deferrals (live turn / interactive pane) on the #2070 path. */
  autoCompleteDeferredTotal: number;
  /**
   * Cumulative strict/soft/capacity-pressure reclaims held back by the TOCTOU
   * re-check (issue #3040): a resumed live turn, a high-confidence interactive
   * pane, or a confirmed-open PR hold that landed between selection and
   * force-complete. A rising counter means the guard is doing its job — tasks
   * that were no longer safe to close were deferred instead of force-completed
   * out from under live work.
   */
  reclaimDeferredTotal: number;
  /**
   * Age-at-auto-complete / pressure-reclaim histogram counts, keyed by
   * upper-bound minutes (`"5"`, `"12"`, `"15"`, …, `"+Inf"`). Cumulative
   * since process start. Meta auto-complete and capacity-pressure early
   * reclaim both record ages here (issue #2355).
   */
  autoCompleteAgeHistogram: Record<string, number>;
  /** Soft TTL used on the last selection pass (issue #2355), or null if never set. */
  softTtlMs: number | null;
  /** Whether capacity-pressure early reclaim was enabled on the last pass (issue #2355). */
  capacityEarlyReclaim: boolean;
}

/**
 * Process-lifetime counters for finishedAwaitingAck reclaim (#1884),
 * meta auto-complete (#2070), skip-reason breakdown (#2084), and
 * capacity-pressure soft reclaim (#2355). One instance at bootstrap,
 * threaded into the sweep, `/metrics`, and `/api/health`.
 */
export class FinishedAwaitingAckTtlReclaimMetrics {
  private reclaimedTotal = 0;
  private reclaimAttempted = 0;
  private capacityPressureEarlyReclaimedTotal = 0;
  private skips: FinishedAwaitingAckReclaimSkipCounts =
    emptyFinishedAwaitingAckReclaimSkipCounts();
  private lastCandidatesConsidered = 0;
  private lastOutcomes: FinishedAwaitingAckReclaimCandidateOutcome[] = [];
  private lastAttemptedTaskIds: string[] = [];
  private autoCompletedTotal = 0;
  private autoCompleteDeferredTotal = 0;
  private reclaimDeferredTotal = 0;
  private autoCompleteAgeHistogram: Record<string, number> = emptyAgeHistogram();
  private softTtlMs: number | null = null;
  private capacityEarlyReclaim = false;

  recordReclaimed(count: number): void {
    if (count > 0) this.reclaimedTotal += count;
  }

  recordCapacityPressureEarlyReclaimed(count: number, agesMs: readonly number[] = []): void {
    if (count > 0) this.capacityPressureEarlyReclaimedTotal += count;
    for (const ageMs of agesMs) {
      const key = ageHistogramBucketKey(ageMs);
      this.autoCompleteAgeHistogram[key] = (this.autoCompleteAgeHistogram[key] ?? 0) + 1;
    }
  }

  recordAttempted(count: number): void {
    if (count > 0) this.reclaimAttempted += count;
  }

  /**
   * Accumulate skip-reason counts from one strict selection pass and remember
   * the candidate denominator + task-id outcomes for the health snapshot.
   */
  recordSelection(selection: {
    candidatesConsidered: number;
    skips: FinishedAwaitingAckReclaimSkipCounts;
    outcomes?: readonly FinishedAwaitingAckReclaimCandidateOutcome[];
  }): void {
    this.lastCandidatesConsidered = selection.candidatesConsidered;
    this.skips.skipped_bad_raised_at += selection.skips.skipped_bad_raised_at;
    this.skips.skipped_open_pr_confirmed += selection.skips.skipped_open_pr_confirmed;
    this.skips.skipped_open_pr_unknown += selection.skips.skipped_open_pr_unknown;
    this.skips.skipped_under_ttl += selection.skips.skipped_under_ttl;
    const outcomes = selection.outcomes ?? [];
    this.lastOutcomes = outcomes.slice(0, MAX_LAST_OUTCOMES).map((o) => ({ ...o }));
    this.lastAttemptedTaskIds = outcomes
      .filter(
        (o) =>
          o.outcome === 'selected' || o.outcome === 'capacity_pressure_early_reclaim',
      )
      .map((o) => o.taskId)
      .slice(0, MAX_LAST_OUTCOMES);
  }

  /** Soft TTL + capacity gate used on the last selection pass (issue #2355). */
  recordSoftTtlPolicy(opts: { softTtlMs: number; capacityEarlyReclaim: boolean }): void {
    if (Number.isFinite(opts.softTtlMs) && opts.softTtlMs > 0) {
      this.softTtlMs = Math.floor(opts.softTtlMs);
    }
    this.capacityEarlyReclaim = opts.capacityEarlyReclaim === true;
  }

  recordAutoCompleted(count: number, agesMs: readonly number[] = []): void {
    if (count > 0) this.autoCompletedTotal += count;
    for (const ageMs of agesMs) {
      const key = ageHistogramBucketKey(ageMs);
      this.autoCompleteAgeHistogram[key] = (this.autoCompleteAgeHistogram[key] ?? 0) + 1;
    }
  }

  recordAutoCompleteDeferred(count: number): void {
    if (count > 0) this.autoCompleteDeferredTotal += count;
  }

  /** Strict/soft/capacity-pressure reclaims deferred by the TOCTOU re-check — live turn / interactive pane / open-PR hold (issue #3040). */
  recordReclaimDeferred(count: number): void {
    if (count > 0) this.reclaimDeferredTotal += count;
  }

  getSnapshot(): FinishedAwaitingAckTtlReclaimMetricsSnapshot {
    return {
      reclaimedTotal: this.reclaimedTotal,
      reclaimAttempted: this.reclaimAttempted,
      reclaimSucceeded: this.reclaimedTotal,
      capacityPressureEarlyReclaimedTotal: this.capacityPressureEarlyReclaimedTotal,
      skippedBadRaisedAt: this.skips.skipped_bad_raised_at,
      skippedOpenPrFailsafe: finishedAwaitingAckOpenPrFailsafeSkipTotal(this.skips),
      skippedOpenPrConfirmed: this.skips.skipped_open_pr_confirmed,
      skippedOpenPrUnknown: this.skips.skipped_open_pr_unknown,
      skippedUnderTtl: this.skips.skipped_under_ttl,
      lastCandidatesConsidered: this.lastCandidatesConsidered,
      lastOutcomes: this.lastOutcomes.map((o) => ({ ...o })),
      lastAttemptedTaskIds: [...this.lastAttemptedTaskIds],
      autoCompletedTotal: this.autoCompletedTotal,
      autoCompleteDeferredTotal: this.autoCompleteDeferredTotal,
      reclaimDeferredTotal: this.reclaimDeferredTotal,
      autoCompleteAgeHistogram: { ...this.autoCompleteAgeHistogram },
      softTtlMs: this.softTtlMs,
      capacityEarlyReclaim: this.capacityEarlyReclaim,
    };
  }
}

function emptyAgeHistogram(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const bound of META_FAA_AUTO_COMPLETE_AGE_BUCKETS_MS) {
    out[String(bound / 60_000)] = 0;
  }
  out['+Inf'] = 0;
  return out;
}

function ageHistogramBucketKey(ageMs: number): string {
  for (const bound of META_FAA_AUTO_COMPLETE_AGE_BUCKETS_MS) {
    if (ageMs <= bound) return String(bound / 60_000);
  }
  return '+Inf';
}

/**
 * True when pane text shows a human-interactive prompt (permission dialog or
 * idle input prompt). Used as the Lucy #2238-style tail veto so we never
 * auto-complete under an active human composer / approval UI.
 */
export function paneHasHumanInteractiveMarkers(paneText: string | undefined | null): boolean {
  if (!paneText) return false;
  const semantics = analyzePaneSemantics(paneText);
  return (
    (semantics.state === 'input_prompt' || semantics.state === 'permission_dialog')
    && semantics.confidence === 'high'
  );
}

export interface ReclaimFinishedAwaitingAckTasksDeps {
  taskStore: TaskStore;
  /** Optional lifecycle context — required for the force-complete to actually run; absent ⇒ no-op. */
  lifecycleDeps?: LifecycleDeps;
  /** Path to the shared audit.jsonl log — every reclaim writes a `system:finished-awaiting-ack-ttl` row. */
  auditLogPath?: string;
  /** Optional broadcast for the sweep-summary alert — reuses the existing 'alert' channel. */
  broadcastToAll?: (msg: ServerMessage) => void;
  /**
   * Stranded-PR / `merge_required` exemption predicate (issue #1884) — see
   * `core/finished-awaiting-ack-ttl.ts` for the fail-safe contract. Omitted ⇒
   * every candidate is treated as a possible PR hold and left alone.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
  /**
   * Optional live pane/tail reader for the #2070 TOCTOU veto. When present,
   * high-confidence human interactive markers defer auto-complete. May be
   * async (e.g. TaskTailStore.getByTaskId).
   */
  getTaskPaneText?: (
    taskId: string,
  ) => string | undefined | null | Promise<string | undefined | null>;
  /** Optional counters for strict reclaim + meta auto-complete + skip breakdown. */
  metrics?: Pick<
    FinishedAwaitingAckTtlReclaimMetrics,
    | 'recordReclaimed'
    | 'recordCapacityPressureEarlyReclaimed'
    | 'recordAttempted'
    | 'recordSelection'
    | 'recordSoftTtlPolicy'
    | 'recordAutoCompleted'
    | 'recordAutoCompleteDeferred'
    | 'recordReclaimDeferred'
  >;
}

export interface ReclaimFinishedAwaitingAckTasksResult {
  reclaimedTaskIds: string[];
  /** Subset of reclaimedTaskIds closed via capacity-pressure soft TTL (issue #2355). */
  capacityPressureEarlyReclaimedTaskIds: string[];
  /** Meta/playbook FAA tasks auto-completed by the #2070 path this sweep. */
  autoCompletedTaskIds: string[];
  /** Candidates deferred by TOCTOU (live turn / interactive pane) this sweep. */
  deferredTaskIds: string[];
  /** Strict-path selection snapshot from this pass (issue #2084). */
  selection?: {
    candidatesConsidered: number;
    skips: FinishedAwaitingAckReclaimSkipCounts;
    selectedCount: number;
    outcomes: FinishedAwaitingAckReclaimCandidateOutcome[];
  };
}

/**
 * Reclaim finishedAwaitingAck tasks past the TTL (issue #1884), capacity-pressure
 * soft TTL for `awaiting_poll` phantoms (issue #2355), and age-gated
 * meta/playbook auto-complete (issue #2070). Runs on the liveness tick, after
 * the pending-task TTL sweep.
 *
 * Strict path (#1884 / #2355): force-complete when `isHoldingOpenPr === false`
 * only. Soft path under capacity pressure uses a shorter TTL for
 * `awaiting_poll` only — never for `manual_review_gate` / `auto_close_disabled`.
 * Actionable relaxed path (#2695): under capacity pressure, a non-ask-first FAA
 * past `actionableReclaimTtlMs` reclaims even when its open-PR state is
 * unconfirmed — only a *confirmed* open PR still blocks it; ask-first holds are
 * never relaxed.
 *
 * Meta path (#2070): allowlisted meta/playbook (or http-source) tasks past
 * the meta age gate, with relaxed PR fail-safe (only confirmed-open blocks)
 * and TOCTOU re-GET + live-turn / interactive-pane veto immediately before
 * complete. Reuses the existing `completeTask` transition — no new kill path.
 *
 * One summary alert per sweep (not per task), matching `expirePendingTasks`.
 */
export async function reclaimAgedFinishedAwaitingAckTasks(
  deps: ReclaimFinishedAwaitingAckTasksDeps,
  opts: {
    now?: Date;
    ttlMs?: number;
    /** Soft TTL for capacity-pressure early reclaim (issue #2355). */
    softTtlMs?: number;
    /**
     * Conservative age past which an actionable (non-ask-first) FAA reclaims
     * under the relaxed open-PR fail-safe (issue #2695). Only active together
     * with `capacityAllowsEarlyReclaim`.
     */
    actionableReclaimTtlMs?: number;
    /** When true, `awaiting_poll` may reclaim at soft TTL (issue #2355). */
    capacityAllowsEarlyReclaim?: boolean;
    /** Meta auto-complete age gate; defaults to {@link DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS}. */
    metaAutoCompleteTtlMs?: number;
  } = {},
): Promise<ReclaimFinishedAwaitingAckTasksResult> {
  const empty: ReclaimFinishedAwaitingAckTasksResult = {
    reclaimedTaskIds: [],
    capacityPressureEarlyReclaimedTaskIds: [],
    autoCompletedTaskIds: [],
    deferredTaskIds: [],
  };
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return empty;

  const now = opts.now ?? new Date();
  const softTtlMs = opts.softTtlMs ?? DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS;
  const capacityAllowsEarlyReclaim = opts.capacityAllowsEarlyReclaim === true;
  deps.metrics?.recordSoftTtlPolicy({
    softTtlMs,
    capacityEarlyReclaim: capacityAllowsEarlyReclaim,
  });

  // Issue #2084 / #2355: accumulate skip-reason counts every pass so /api/health
  // can explain residual finishedAwaitingAck when reclaimedTotal stays flat.
  const selection = selectExpiredFinishedAwaitingAckTasks(deps.taskStore.viewTasks(), {
    now,
    ttlMs: opts.ttlMs,
    softTtlMs,
    // `undefined` falls back to the module default inside the selector, matching
    // the adjacent `softTtlMs` pass-through (no eager normalization needed here).
    actionableReclaimTtlMs: opts.actionableReclaimTtlMs,
    capacityAllowsEarlyReclaim,
    isHoldingOpenPr: deps.isHoldingOpenPr,
  });
  deps.metrics?.recordSelection(selection);
  deps.metrics?.recordAttempted(selection.expired.length);

  const reclaimedTaskIds: string[] = [];
  const capacityPressureEarlyReclaimedTaskIds: string[] = [];
  const capacityPressureAges: number[] = [];
  // Shared with the #2070 meta path below so both TOCTOU vetoes accrue to one
  // per-sweep deferral list (and the meta selection skips ids the strict path
  // already deferred).
  const deferredTaskIds: string[] = [];
  for (const { task, ageMs, capacityPressureEarlyReclaim, actionableRelaxedReclaim } of selection.expired) {
    // TOCTOU re-GET + live-turn / interactive-pane veto (Lucy #2238 pattern),
    // mirroring the ack-path reaper (#2170) and the meta auto-complete path
    // below. Pure selection is age-only; between selection and force-complete a
    // finished task can have its turn resumed by a follow-up prompt — which
    // leaves the stale `completion_ready` signal set (so it still classifies as
    // FAA) while `lastTurnState` goes back to `running`. The strict/soft/
    // capacity-pressure reclaim is the one FAA close path that was missing this
    // guard, so under capacity pressure it force-completed tasks out from under
    // live work at the 5m soft TTL (issue #3040). Defer instead — a genuinely
    // idle FAA re-selects next tick and reclaims then.
    const fresh = deps.taskStore.getTask(task.id);
    if (
      !fresh
      || fresh.status !== 'inProgress'
      || fresh.pendingSignal?.kind !== 'completion_ready'
    ) {
      // Acked / dismissed / transitioned since selection — no longer ours to close.
      continue;
    }
    if (taskHasLiveTurn(fresh)) {
      deferredTaskIds.push(task.id);
      console.warn(
        `[finished-awaiting-ack-ttl] deferred task ${task.id} — turn resumed (live turn) since selection`,
      );
      continue;
    }
    const paneText = deps.getTaskPaneText ? await deps.getTaskPaneText(task.id) : undefined;
    if (paneHasHumanInteractiveMarkers(paneText)) {
      deferredTaskIds.push(task.id);
      console.warn(
        `[finished-awaiting-ack-ttl] deferred task ${task.id} — pane shows a human-interactive prompt`,
      );
      continue;
    }
    // A confirmed-open delivery PR may have landed between selection and now.
    // Never force-complete out from under it — the PR is the deliverable and a
    // premature "completed" would strand it. Only a definite `true` blocks here
    // (parity with the ack-path reaper #2170); an unknown/unconfirmed ref does
    // not re-exempt an actionable relaxed reclaim the selector already cleared
    // (issue #2695), so this re-check is safe for both the strict and relaxed
    // selections.
    if (deps.isHoldingOpenPr?.(fresh) === true) {
      deferredTaskIds.push(task.id);
      console.warn(
        `[finished-awaiting-ack-ttl] deferred task ${task.id} — confirmed-open PR hold landed since selection`,
      );
      continue;
    }
    const reason = capacityPressureEarlyReclaim
      ? 'finished_awaiting_ack_capacity_pressure'
      : 'finished_awaiting_ack_ttl';
    const actor = capacityPressureEarlyReclaim
      ? 'system:finished-awaiting-ack-capacity-pressure'
      : 'system:finished-awaiting-ack-ttl';
    try {
      await completeTask(task.id, lifecycleDeps, { interactionLogReason: reason });
    } catch (err) {
      // Raced a manual ack or another terminal transition — skip; the task is
      // no longer (only) finishedAwaitingAck, so it is somebody else's to finish.
      console.warn(
        `[finished-awaiting-ack-ttl] could not reclaim task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    deps.taskStore.clearPendingSignal(task.id);
    reclaimedTaskIds.push(task.id);
    if (capacityPressureEarlyReclaim) {
      capacityPressureEarlyReclaimedTaskIds.push(task.id);
      capacityPressureAges.push(ageMs);
    }
    console.warn(
      `[finished-awaiting-ack-ttl] reclaimed task ${task.id} — finishedAwaitingAck ${Math.round(ageMs / 60_000)}m unacknowledged` +
        (capacityPressureEarlyReclaim ? ' (capacity-pressure soft TTL)' : '') +
        (actionableRelaxedReclaim ? ' (actionable relaxed open-PR fail-safe, #2695)' : ''),
    );

    await appendAuditRow(deps.auditLogPath, {
      type: capacityPressureEarlyReclaim
        ? 'task.finishedAwaitingAckCapacityPressureReclaimed'
        : 'task.finishedAwaitingAckTtlReclaimed',
      timestamp: nowISO(),
      actor,
      taskId: task.id,
      reason,
      ageMs,
      // Issue #2695: mark reclaims that only cleared because the actionable
      // relaxed fail-safe overrode an unknown open-PR state, so an operator can
      // tell them apart from an ordinary hard-TTL reclaim of a no-PR task.
      ...(actionableRelaxedReclaim ? { relaxedOpenPrFailsafe: true } : {}),
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(capacityPressureEarlyReclaim ? { softTtlMs } : {}),
    });
  }

  deps.metrics?.recordReclaimed(reclaimedTaskIds.length);
  deps.metrics?.recordCapacityPressureEarlyReclaimed(
    capacityPressureEarlyReclaimedTaskIds.length,
    capacityPressureAges,
  );
  // Issue #3040: strict/soft/capacity-pressure reclaims held back by the
  // live-turn / interactive-pane veto. Recorded before the meta path so the
  // counter attributes strict deferrals distinctly from the #2070 meta
  // auto-complete deferrals. `deferredTaskIds` holds ONLY strict deferrals at
  // this point — the meta loop appends to the same list afterwards, so capture
  // the boundary to keep the two counters from double-counting.
  const strictDeferredCount = deferredTaskIds.length;
  deps.metrics?.recordReclaimDeferred(strictDeferredCount);

  // Issue #2070: meta/playbook FAA auto-complete for the unfetched-PR-ref residual.
  // Skip ids the strict path already reclaimed OR deferred this sweep (a strict
  // deferral means the task has a live turn / interactive pane — the meta path
  // must not re-close it either).
  const alreadyHandled = new Set([...reclaimedTaskIds, ...deferredTaskIds]);
  const metaEntries = listMetaFinishedAwaitingAckAutoCompleteTasks(deps.taskStore.viewTasks(), {
    now,
    ttlMs: opts.metaAutoCompleteTtlMs ?? DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS,
    isHoldingOpenPr: deps.isHoldingOpenPr,
  }).filter((e) => !alreadyHandled.has(e.task.id));

  const autoCompletedTaskIds: string[] = [];
  const autoCompletedAges: number[] = [];

  for (const { task, ageMs } of metaEntries) {
    // TOCTOU re-GET (Lucy #2238 pattern): refuse if the live record no longer
    // looks like a clean finishedAwaitingAck, the turn is running, or the
    // pane shows human interactive markers.
    const fresh = deps.taskStore.getTask(task.id);
    if (
      !fresh
      || fresh.status !== 'inProgress'
      || fresh.pendingSignal?.kind !== 'completion_ready'
    ) {
      continue;
    }
    if (taskHasLiveTurn(fresh)) {
      deferredTaskIds.push(task.id);
      continue;
    }
    const paneText = deps.getTaskPaneText ? await deps.getTaskPaneText(task.id) : undefined;
    if (paneHasHumanInteractiveMarkers(paneText)) {
      deferredTaskIds.push(task.id);
      continue;
    }
    // Re-check PR hold on the fresh record (state may have landed mid-sweep).
    if (deps.isHoldingOpenPr?.(fresh) === true) {
      continue;
    }

    try {
      await completeTask(task.id, lifecycleDeps, {
        interactionLogReason: 'finished_awaiting_ack_auto_complete',
      });
    } catch (err) {
      console.warn(
        `[finished-awaiting-ack-auto-complete] could not complete task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    deps.taskStore.clearPendingSignal(task.id);
    autoCompletedTaskIds.push(task.id);
    autoCompletedAges.push(ageMs);
    console.warn(
      `[finished-awaiting-ack-auto-complete] completed meta task ${task.id} — ` +
        `finishedAwaitingAck ${Math.round(ageMs / 60_000)}m unacknowledged`,
    );

    await appendAuditRow(deps.auditLogPath, {
      type: 'task.finishedAwaitingAckAutoCompleted',
      timestamp: nowISO(),
      actor: 'system:finished-awaiting-ack-auto-complete',
      taskId: task.id,
      reason: 'finished_awaiting_ack_auto_complete',
      ageMs,
      playbookId: fresh.playbookId,
      ttlMs: opts.metaAutoCompleteTtlMs ?? DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS,
    });
  }

  deps.metrics?.recordAutoCompleted(autoCompletedTaskIds.length, autoCompletedAges);
  // Only the deferrals the meta loop appended — strict deferrals were already
  // attributed to recordReclaimDeferred above (issue #3040).
  deps.metrics?.recordAutoCompleteDeferred(deferredTaskIds.length - strictDeferredCount);

  const totalClosed = reclaimedTaskIds.length + autoCompletedTaskIds.length;
  if (totalClosed > 0) {
    const parts: string[] = [];
    const hardCount = reclaimedTaskIds.length - capacityPressureEarlyReclaimedTaskIds.length;
    if (hardCount > 0) {
      parts.push(`${hardCount} hard-TTL`);
    }
    if (capacityPressureEarlyReclaimedTaskIds.length > 0) {
      parts.push(
        `${capacityPressureEarlyReclaimedTaskIds.length} capacity-pressure soft-TTL`,
      );
    }
    if (autoCompletedTaskIds.length > 0) {
      parts.push(`${autoCompletedTaskIds.length} meta-auto-complete`);
    }
    deps.broadcastToAll?.({
      type: 'alert',
      agentId: '',
      summary: `Reclaimed ${totalClosed} finishedAwaitingAck task(s) (${parts.join(', ')})`,
      details:
        'These tasks finished their work and signalled completion_ready, but sat unacknowledged past ' +
        'the finishedAwaitingAck age gate and were force-completed to free the active concurrency slot. ' +
        'Capacity-pressure soft TTL (#2355) only accelerates awaiting_poll (never ask-first / open-PR holds). ' +
        'Meta/playbook auto-complete (#2070) only acts when TOCTOU is clean (no live turn / interactive pane). ' +
        'Review the completed task if manual follow-up is still needed.',
      severity: 'warning',
    });
  }

  return {
    reclaimedTaskIds,
    capacityPressureEarlyReclaimedTaskIds,
    autoCompletedTaskIds,
    deferredTaskIds,
    selection: {
      candidatesConsidered: selection.candidatesConsidered,
      skips: selection.skips,
      selectedCount: selection.expired.length,
      outcomes: selection.outcomes,
    },
  };
}
