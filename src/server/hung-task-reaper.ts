import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { MergedPrAttribution } from '../core/completion/index.js';
import type { TaskDisposition, TaskReapOutcome } from '../shared/contracts/task.js';
import { appendDispositionEntry, type DispositionEntry } from '../core/disposition-ledger.js';
import { buildReapDisposition } from '../core/hung-task-reaper.js';
import { nowISO } from '../core/interaction-log.js';
import { hungTaskReportBasename } from './hung-task-report-paths.js';
import { terminateTask, type LifecycleDeps } from './agent-lifecycle.js';
import {
  reaperEvidence,
  describeReaperEvidenceFailure,
  writeReaperAuditRow,
  type ReaperEvidenceStatus,
} from './bounded-reaper-evidence.js';
import {
  persistReapReport,
  type ReapReportPersistOutcome,
} from './reap-report-persistence.js';

const PANE_TAIL_LINES = 50;

/** Evidence collected at the moment a task is confirmed reap-eligible (issue #1526 Phase A / FM6). */
export interface HungTaskReapEvidence {
  silentForMs: number;
  thresholdMs: number;
  lastHookEventAt: number;
  lastPaneChangeAt: number;
  lastTokenActivityAt: number;
  /** Raw pane content captured at reap time; the report keeps only the last ~50 lines. */
  paneContent: string;
  /** When a grace-period warning preceded this reap (RFC rfc-reap-grace-warning.md), its warn time — for audit linkage. */
  warnedAt?: number;
  /** How many times the user extended the warning before it reaped. */
  keptAliveCount?: number;
}

export interface HungTaskReaperDeps {
  taskStore: TaskStore;
  lifecycleDeps: LifecycleDeps;
  /** Kookr data-dir "reports" directory. When absent, no report artifact is written (audit + termination still happen). */
  reportsDir?: string;
  /** Path to the shared audit.jsonl log. */
  auditLogPath?: string;
  /**
   * Path to the recovery work-conservation ledger (issue #1540). When
   * absent, no disposition entry is written for the reap — matches the
   * `auditLogPath`/`reportsDir` "no-op when unconfigured" convention above.
   */
  dispositionLedgerPath?: string;
  /** Optional broadcast for the reap alert — reuses the existing 'alert' channel, no new notification surface. */
  broadcastToAll?: (msg: ServerMessage) => void;
  /**
   * Delivery attribution (issue #1559): a task's attributable merged PR, or
   * null. Wired to the same `GitHubStateStore`-backed resolver the
   * delivered-completion sweep uses (#1560) — no new attribution mechanism, no
   * pane scraping, no live GitHub call. Absent → the reap records a plain
   * `terminated` outcome (never a false `delivered_then_hung`).
   */
  resolveMergedPr?: (task: Task) => MergedPrAttribution | null;
  /**
   * Wall-clock bound for the best-effort evidence-report write (issue #2852).
   * The write runs AFTER termination has released capacity, so this only caps
   * how long the audit row / alert / pending-task refill wait on it. Defaults
   * to the helper's `DEFAULT_REAP_REPORT_PERSIST_TIMEOUT_MS` (5s); `<= 0` awaits
   * unbounded. Presently an injectable-for-tests knob — no production caller
   * sets it, so operationally the default always applies.
   */
  reportPersistTimeoutMs?: number;
  /**
   * Reap-failure counters (issue #3154). When wired, a rejecting
   * {@link terminateTask} — the call that actually frees the slot — is recorded
   * here before the reap re-throws, so an un-terminable hung task is no longer
   * indistinguishable from any generic watchdog error. Absent → the reap still
   * re-throws (the generic watchdog catch stays the fallback), just uncounted.
   */
  metrics?: HungTaskReaperMetrics;
  now?: () => Date;
}

export interface HungTaskReapResult {
  reportPath?: string;
  /** Recorded reap outcome (issue #1559): `terminated` or `delivered_then_hung`. */
  outcome: TaskReapOutcome;
  /**
   * Report-persistence signal (issue #2852): `ok` when the report was written,
   * `skipped` when no reports dir is configured, `error`/`timeout` when a
   * wedged data directory could not accept the write in time. Distinct from
   * `outcome` (the lifecycle disposition) — the reap itself always succeeded.
   */
  reportPersistence: ReapReportPersistOutcome['status'];
  /** Ancillary evidence status; a timeout never confirms durability. */
  dispositionPersistence: ReaperEvidenceStatus;
  auditPersistence: ReaperEvidenceStatus;
}

/**
 * Coarse bucket for a reap terminate-failure, surfaced as
 * `lastReapFailureCategory` so an operator can tell a recurring stuck-slot apart
 * from a one-off race without log spelunking (issue #3154). Derived from the
 * error text; `unknown` when nothing recognizable is present rather than
 * guessing.
 */
export type HungTaskReapFailureCategory =
  | 'session_gone'
  | 'timeout'
  | 'permission'
  | 'unknown';

/** Classify a terminate rejection into a {@link HungTaskReapFailureCategory}. */
export function categorizeReapFailure(err: unknown): HungTaskReapFailureCategory {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (!msg) return 'unknown';
  if (
    msg.includes('enoent')
    || msg.includes('no such')
    || msg.includes('not found')
    || msg.includes('gone')
    || msg.includes('no server')
  ) {
    return 'session_gone';
  }
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('eperm') || msg.includes('eacces') || msg.includes('permission')) {
    return 'permission';
  }
  return 'unknown';
}

/**
 * Read-only projection of the hung-task reap-failure counters (issue #3154),
 * carried on the reaper's `/api/health` block alongside the session/host-stale
 * reaper snapshots.
 */
export interface HungTaskReaperMetricsSnapshot {
  /**
   * Cumulative hung-task reaps whose {@link terminateTask} rejected — the slot
   * could not be freed (the issue's `hungReapFailedTotal`). A sustained climb is
   * the offline signal of a reap looping and failing on one un-terminable slot,
   * previously buried inside the generic "Watchdog error" log with no counter.
   */
  reapFailedTotal: number;
  /** Epoch-ms of the most recent terminate failure, or null if none yet. */
  lastReapFailureAt: number | null;
  /** Coarse category of the most recent terminate failure, or null if none yet. */
  lastReapFailureCategory: HungTaskReapFailureCategory | null;
}

/**
 * Process-lifetime counters for hung-task reap terminate-failures (issue #3154).
 * A single instance is wired through the timer deps into {@link reapHungTask}
 * and read back on `/api/health`. Mirrors the FAA ack-path reaper's
 * `FinishedAwaitingAckAckReaperMetrics.reapFailedTotal` signal (issue #3156) for
 * the hung-task capacity class.
 */
export class HungTaskReaperMetrics {
  private reapFailedTotal = 0;
  private lastReapFailureAt: number | null = null;
  private lastReapFailureCategory: HungTaskReapFailureCategory | null = null;

  /** Record one terminate rejection at `atMs`, bucketing `err` for the operator. */
  recordReapFailure(err: unknown, atMs: number): void {
    this.reapFailedTotal += 1;
    this.lastReapFailureAt = atMs;
    this.lastReapFailureCategory = categorizeReapFailure(err);
  }

  getSnapshot(): HungTaskReaperMetricsSnapshot {
    return {
      reapFailedTotal: this.reapFailedTotal,
      lastReapFailureAt: this.lastReapFailureAt,
      lastReapFailureCategory: this.lastReapFailureCategory,
    };
  }
}

function formatAgeFromNow(now: Date, at: number): string {
  if (at === 0) return 'never';
  const ms = now.getTime() - at;
  const minutes = Math.round(ms / 60_000);
  return `${new Date(at).toISOString()} (${minutes}m ago)`;
}

function buildHungTaskReportMarkdown(task: Task, evidence: HungTaskReapEvidence, now: Date): string {
  const tail = evidence.paneContent.split('\n').slice(-PANE_TAIL_LINES).join('\n');
  return `# Hung-task reap report

- **Task ID:** ${task.id}
- **Task name:** ${task.name ?? '(unnamed)'}
- **Prompt:** ${task.prompt}
- **cwd:** ${task.cwd}
- **Reaped at:** ${now.toISOString()}
- **Silent for:** ${Math.round(evidence.silentForMs / 60_000)}m (threshold: ${Math.round(evidence.thresholdMs / 60_000)}m)

## Liveness timeline (last activity per channel)

- Hook events: ${formatAgeFromNow(now, evidence.lastHookEventAt)}
- Pane-content change: ${formatAgeFromNow(now, evidence.lastPaneChangeAt)}
- Token-count movement: ${formatAgeFromNow(now, evidence.lastTokenActivityAt)}

## Pane tail (last ${PANE_TAIL_LINES} lines)

\`\`\`
${tail}
\`\`\`
`;
}

/**
 * Write the reap evidence report and resolve its path. Errors propagate: the
 * caller runs this through {@link persistReapReport}, which bounds and catches
 * it so a wedged data directory can never delay or crash the reap (issue #2852).
 */
async function writeHungTaskReport(
  task: Task,
  evidence: HungTaskReapEvidence,
  reportsDir: string,
  now: Date,
): Promise<string> {
  const slug = now.toISOString().replace(/[:.]/g, '-');
  const reportPath = join(reportsDir, hungTaskReportBasename(task.id, slug));
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, buildHungTaskReportMarkdown(task, evidence, now), 'utf-8');
  return reportPath;
}

/**
 * Reap a single hung task (issue #1526 Phase A / FM6): terminate the task
 * (kills the session via the terminal backend's
 * existing kill path, transitions to the existing `terminated` status, purges
 * attention-queue entries, releases leases/claims — all via the same
 * `terminateTask` reconcile() already uses for dead sessions), then attempt
 * bounded evidence writes and broadcast an alert. The caller is responsible for confirming
 * eligibility (see `evaluateHungTaskReap` in core/hung-task-reaper.ts) before
 * calling this, and for triggering pending-task promotion afterward.
 */
export async function reapHungTask(
  task: Task,
  evidence: HungTaskReapEvidence,
  deps: HungTaskReaperDeps,
): Promise<HungTaskReapResult> {
  const now = deps.now?.() ?? new Date();

  // Attribute delivery BEFORE terminating, so a task that already merged its PR
  // is recorded as `delivered_then_hung` instead of masking the delivery as a
  // plain `terminated` (issue #1559). Reuses the delivered-completion sweep's
  // attribution (#1560) — cached GitHub state, no pane scrape, no live call.
  const merged = deps.resolveMergedPr?.(task) ?? null;
  const disposition = buildReapDisposition(merged, now.toISOString());
  const outcome = disposition.outcome ?? 'terminated';

  // Terminate and release capacity BEFORE any evidence-report I/O (issue
  // #2852). The report is a diagnostic artifact, not lifecycle state; writing
  // it first meant a full/slow/wedged data directory could stall capacity
  // release indefinitely — exactly during the disk pressure when unattended
  // recovery matters most. The report is persisted best-effort further down,
  // bounded so a never-settling write cannot delay the reap.
  try {
    await terminateTask(task.id, deps.lifecycleDeps, {
      reason: 'timeout',
      detail: `hung-task-reaper: silent for ${Math.round(evidence.silentForMs / 1000)}s (threshold ${Math.round(evidence.thresholdMs / 1000)}s)`,
    });
  } catch (err) {
    // The terminate that frees the slot rejected (issue #3154). Previously this
    // throw was unguarded: it skipped the audit row + disposition below and
    // surfaced only as a generic "Watchdog error" in the one caller — a hung
    // task that cannot be terminated re-warned and re-failed every watchdog tick
    // with nothing reap-specific to see. Record a reap-specific failure
    // (counter + last-failure fields, read back on /api/health) and keep a loud,
    // retained log line so a genuinely broken terminate is never silent, then
    // re-throw so the disposition/audit/alert for a *successful* reap below stay
    // correctly skipped and the caller's generic watchdog catch stays the
    // fallback that keeps the rest of the sweep going.
    deps.metrics?.recordReapFailure(err, now.getTime());
    console.error(
      `[hung-task-reaper] terminate failed for task ${task.id} — slot still held, reap will retry next tick:`,
      err,
    );
    throw err;
  }

  // Record the disposition on the (still-present) terminated task record. The
  // store keeps reaped tasks, and setDisposition is first-write-wins, so this
  // is the single durable outcome marker for the reap (issue #1559).
  deps.taskStore.setDisposition(task.id, disposition);

  // Work-conservation ledger entry (issue #1540): a reap always cancels a
  // task, but that alone doesn't prove the work was conserved. `outcome`
  // already tells us which: a `delivered_then_hung` task shipped its work
  // before hanging (nothing to respawn — obsolete), while a plain
  // `terminated` reap has no confirmed delivery and the reaper never
  // auto-respawns, so it needs a human to decide retry vs abandon. Bound only
  // the ancillary wait: a timeout leaves durability unknown and the write
  // occupies its shared slot until it settles. Lost evidence stays loud.
  const logPrefix = `[hung-task-reaper] task ${task.id}:`;
  const dispositionPersistence = deps.dispositionLedgerPath
    ? await reaperEvidence.write(
        'disposition',
        () => writeReapDispositionEntry(task.id, disposition, outcome, evidence, deps, now),
        logPrefix,
      )
    : 'skipped';

  // Persist the evidence report best-effort, now that capacity is already
  // released (issue #2852). Bounded so a wedged data directory cannot delay the
  // audit row / alert / pending-task refill, and every failure — including a
  // late rejection after the bound — is caught inside `persistReapReport`.
  const report: ReapReportPersistOutcome = deps.reportsDir
    ? await persistReapReport(
        () => writeHungTaskReport(task, evidence, deps.reportsDir!, now),
        deps.reportPersistTimeoutMs,
        `[hung-task-reaper] task ${task.id}:`,
      )
    : { status: 'skipped' };
  const reportPath = report.status === 'ok' ? report.reportPath : undefined;

  const auditRow = {
    type: 'task.hungTaskReap',
    timestamp: nowISO(),
    actor: 'system:hung-task-reaper',
    taskId: task.id,
    silentForMs: evidence.silentForMs,
    thresholdMs: evidence.thresholdMs,
    outcome,
    ...(disposition.deliveredPr ? { deliveredPr: disposition.deliveredPr } : {}),
    evidence: {
      lastHookEventAt: evidence.lastHookEventAt,
      lastPaneChangeAt: evidence.lastPaneChangeAt,
      lastTokenActivityAt: evidence.lastTokenActivityAt,
    },
    ...(evidence.warnedAt !== undefined ? { warnedAt: evidence.warnedAt } : {}),
    ...(evidence.keptAliveCount !== undefined ? { keptAliveCount: evidence.keptAliveCount } : {}),
    ...(reportPath ? { reportPath } : {}),
    // Surface a report-persistence failure on the durable trail (issue #2852)
    // without touching the happy-path shape: `error`/`timeout` only.
    ...(report.status === 'error' || report.status === 'timeout'
      ? { reportPersistence: report.status }
      : {}),
    ...(describeReaperEvidenceFailure('disposition', dispositionPersistence)
      ? { dispositionPersistence }
      : {}),
  };
  const auditPersistence = deps.auditLogPath
    ? await reaperEvidence.write('audit', () => writeReaperAuditRow(deps.auditLogPath!, auditRow), logPrefix)
    : 'skipped';

  const silentMinutes = Math.round(evidence.silentForMs / 60_000);
  deps.broadcastToAll?.({
    type: 'alert',
    agentId: task.sessions[task.sessions.length - 1]?.tmuxSession ?? '',
    summary: disposition.deliveredPr
      ? `Reaped delivered-then-hung task (PR #${disposition.deliveredPr.number}): ${task.name ?? task.id}`
      : `Reaped hung task: ${task.name ?? task.id}`,
    details: (disposition.deliveredPr
      ? `Delivered PR #${disposition.deliveredPr.number}, then no hook events, pane change, or token activity for ${silentMinutes}m — session terminated.`
      : `No hook events, pane change, or token activity for ${silentMinutes}m — session terminated.`)
      + describeReaperEvidenceFailure('disposition', dispositionPersistence)
      + describeReaperEvidenceFailure('audit', auditPersistence),
    severity: 'warning',
  });

  return { reportPath, outcome, reportPersistence: report.status, dispositionPersistence, auditPersistence };
}

/**
 * Record the reap's work-conservation entry (issue #1540). No-op when
 * `dispositionLedgerPath` isn't configured. Bucketed daily rather than per-
 * reap: the reaper has no shared "recovery run" id the way a boot has
 * `restartEpoch`, and a daily incident bucket is still precise enough for
 * `auditRecoveryDispositions`'s window-based query (AC3) to find it.
 */
async function writeReapDispositionEntry(
  taskId: string,
  taskDisposition: TaskDisposition,
  outcome: TaskReapOutcome,
  evidence: HungTaskReapEvidence,
  deps: HungTaskReaperDeps,
  now: Date,
): Promise<void> {
  if (!deps.dispositionLedgerPath) return;
  const ledgerPath = deps.dispositionLedgerPath;
  const silentMinutes = Math.round(evidence.silentForMs / 60_000);
  const entry: DispositionEntry =
    outcome === 'delivered_then_hung'
      ? {
        schemaVersion: 'disposition-ledger.v1',
        taskId,
        disposition: 'obsolete',
        detail: taskDisposition.deliveredPr
          ? `obsolete-because: delivered PR #${taskDisposition.deliveredPr.number} before hanging; no respawn needed`
          : 'obsolete-because: delivered its work before hanging; no respawn needed',
        incidentId: reapIncidentId(now),
        source: 'hung-task-reaper',
        at: now.toISOString(),
      }
      : {
        schemaVersion: 'disposition-ledger.v1',
        taskId,
        disposition: 'needs-human',
        detail: `needs-human: reaped after ${silentMinutes}m of silence with no confirmed delivery — the reaper does not auto-respawn, a human must decide retry vs abandon`,
        incidentId: reapIncidentId(now),
        source: 'hung-task-reaper',
        at: now.toISOString(),
      };
  await appendDispositionEntry(ledgerPath, entry);
}

function reapIncidentId(now: Date): string {
  return `hung-task-reap-${now.toISOString().slice(0, 10)}`;
}
