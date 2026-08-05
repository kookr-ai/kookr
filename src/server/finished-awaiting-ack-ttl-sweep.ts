import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { completeTask, type LifecycleDeps } from './agent-lifecycle.js';
import {
  listExpiredFinishedAwaitingAckTasks,
  listMetaFinishedAwaitingAckAutoCompleteTasks,
  taskHasLiveTurn,
  DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS,
} from '../core/finished-awaiting-ack-ttl.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import { analyzePaneSemantics } from '../shared/pane-semantics.js';

/** Age histogram buckets (ms) for meta FAA auto-complete (issue #2070). */
export const META_FAA_AUTO_COMPLETE_AGE_BUCKETS_MS = [
  12 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
] as const;

/** In-memory snapshot for `/metrics` + `/api/health` (issues #1884 / #2070). */
export interface FinishedAwaitingAckTtlReclaimMetricsSnapshot {
  /** Cumulative finishedAwaitingAck tasks force-completed by the strict TTL reclaim since process start. */
  reclaimedTotal: number;
  /**
   * Cumulative meta/playbook FAA tasks auto-completed by the #2070 path
   * (allowlist + relaxed PR fail-safe + TOCTOU).
   */
  autoCompletedTotal: number;
  /** Cumulative TOCTOU deferrals (live turn / interactive pane) on the #2070 path. */
  autoCompleteDeferredTotal: number;
  /**
   * Age-at-auto-complete histogram counts, keyed by upper-bound minutes
   * (`"12"`, `"15"`, …, `"+Inf"`). Cumulative since process start.
   */
  autoCompleteAgeHistogram: Record<string, number>;
}

/**
 * Process-lifetime counters for finishedAwaitingAck reclaim (#1884) and
 * meta auto-complete (#2070). One instance at bootstrap, threaded into the
 * sweep, `/metrics`, and `/api/health`.
 */
export class FinishedAwaitingAckTtlReclaimMetrics {
  private reclaimedTotal = 0;
  private autoCompletedTotal = 0;
  private autoCompleteDeferredTotal = 0;
  private autoCompleteAgeHistogram: Record<string, number> = emptyAgeHistogram();

  recordReclaimed(count: number): void {
    if (count > 0) this.reclaimedTotal += count;
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

  getSnapshot(): FinishedAwaitingAckTtlReclaimMetricsSnapshot {
    return {
      reclaimedTotal: this.reclaimedTotal,
      autoCompletedTotal: this.autoCompletedTotal,
      autoCompleteDeferredTotal: this.autoCompleteDeferredTotal,
      autoCompleteAgeHistogram: { ...this.autoCompleteAgeHistogram },
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
  /** Optional counters for strict reclaim + meta auto-complete. */
  metrics?: Pick<
    FinishedAwaitingAckTtlReclaimMetrics,
    'recordReclaimed' | 'recordAutoCompleted' | 'recordAutoCompleteDeferred'
  >;
}

export interface ReclaimFinishedAwaitingAckTasksResult {
  reclaimedTaskIds: string[];
  /** Meta/playbook FAA tasks auto-completed by the #2070 path this sweep. */
  autoCompletedTaskIds: string[];
  /** Candidates deferred by TOCTOU (live turn / interactive pane) this sweep. */
  deferredTaskIds: string[];
}

/**
 * Reclaim finishedAwaitingAck tasks past the TTL (issue #1884) and
 * age-gated meta/playbook auto-complete (issue #2070). Runs on the liveness
 * tick, after the pending-task TTL sweep.
 *
 * Strict path (#1884): force-complete when `isHoldingOpenPr === false` only.
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
    /** Meta auto-complete age gate; defaults to {@link DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS}. */
    metaAutoCompleteTtlMs?: number;
  } = {},
): Promise<ReclaimFinishedAwaitingAckTasksResult> {
  const empty: ReclaimFinishedAwaitingAckTasksResult = {
    reclaimedTaskIds: [],
    autoCompletedTaskIds: [],
    deferredTaskIds: [],
  };
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return empty;

  const now = opts.now ?? new Date();
  const entries = listExpiredFinishedAwaitingAckTasks(deps.taskStore.listTasks(), {
    now,
    ttlMs: opts.ttlMs,
    isHoldingOpenPr: deps.isHoldingOpenPr,
  });

  const reclaimedTaskIds: string[] = [];
  for (const { task, ageMs } of entries) {
    try {
      await completeTask(task.id, lifecycleDeps, { interactionLogReason: 'finished_awaiting_ack_ttl' });
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
    console.warn(
      `[finished-awaiting-ack-ttl] reclaimed task ${task.id} — finishedAwaitingAck ${Math.round(ageMs / 60_000)}m unacknowledged`,
    );

    await appendAuditRow(deps.auditLogPath, {
      type: 'task.finishedAwaitingAckTtlReclaimed',
      timestamp: nowISO(),
      actor: 'system:finished-awaiting-ack-ttl',
      taskId: task.id,
      reason: 'finished_awaiting_ack_ttl',
      ageMs,
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    });
  }

  deps.metrics?.recordReclaimed(reclaimedTaskIds.length);

  // Issue #2070: meta/playbook FAA auto-complete for the unfetched-PR-ref residual.
  const alreadyHandled = new Set(reclaimedTaskIds);
  const metaEntries = listMetaFinishedAwaitingAckAutoCompleteTasks(deps.taskStore.listTasks(), {
    now,
    ttlMs: opts.metaAutoCompleteTtlMs ?? DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS,
    isHoldingOpenPr: deps.isHoldingOpenPr,
  }).filter((e) => !alreadyHandled.has(e.task.id));

  const autoCompletedTaskIds: string[] = [];
  const deferredTaskIds: string[] = [];
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
  deps.metrics?.recordAutoCompleteDeferred(deferredTaskIds.length);

  const totalClosed = reclaimedTaskIds.length + autoCompletedTaskIds.length;
  if (totalClosed > 0) {
    const parts: string[] = [];
    if (reclaimedTaskIds.length > 0) {
      parts.push(`${reclaimedTaskIds.length} strict-TTL`);
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
        'Meta/playbook auto-complete (#2070) only acts when TOCTOU is clean (no live turn / interactive pane). ' +
        'Review the completed task if manual follow-up is still needed.',
      severity: 'warning',
    });
  }

  return { reclaimedTaskIds, autoCompletedTaskIds, deferredTaskIds };
}
