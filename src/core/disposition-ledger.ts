import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('disposition-ledger');

/**
 * Recovery work-conservation ledger (issue #1540).
 *
 * Recovery paths (hung-task reaper, crash recovery, boot-time stale-launch
 * sweep) cancel or degrade tasks all the time — that's expected. What was
 * missing is proof the underlying WORK was conserved: was it respawned
 * somewhere else, genuinely obsolete, or does it need a human to look at it?
 * During the 2026-07-24 deadlock recovery, tasks #1542-#1545 were
 * force-cancelled and 22 tasks were KB-degraded with no disposition trail —
 * reconstructing "did we lose work?" required an archaeology session across
 * logs.
 *
 * This module is a small, self-contained JSONL ledger (mirrors the
 * append/read shape of `ralph-iteration-log.ts` and `audit-log.ts`, since
 * `outcome-ledger.ts` itself is a pure in-memory projection with no
 * persistence to mirror) plus a loud post-recovery audit. It deliberately
 * does NOT reuse `Task.disposition` (`shared/contracts/task.ts`,
 * `TaskStore.setDisposition` — issue #1588/#1559): that field is a
 * first-write-wins "why was this task disposed" tag with a fixed reason enum,
 * stored only on the live task record. This issue needs a THIRD, orthogonal
 * axis — "was the work conserved" (`respawned` / `obsolete` / `needs-human`)
 * — that must survive independently of the task record (queryable per
 * incident window, auditable even if the task is later pruned). Extending the
 * shared `TaskDisposition` shape to carry that would mean editing
 * `shared/contracts/task.ts` and `core/tasks.ts`, both outside this change's
 * scope; a small purpose-built ledger keeps this PR minimal and self-
 * contained. See the disposition-ledger.test.ts header for the write-up.
 */

export type DispositionKind = 'respawned' | 'obsolete' | 'needs-human';

export interface DispositionEntry {
  schemaVersion: 'disposition-ledger.v1';
  /** The task the recovery path cancelled or degraded. */
  taskId: string;
  /** One of `respawned-as: <id>` | `obsolete-because: <reason>` | `needs-human` (issue #1540 AC1). */
  disposition: DispositionKind;
  /**
   * Free-text detail. For `respawned`, names the new task/session id the work
   * continues under. For `obsolete`, explains why the work no longer needs
   * doing. For `needs-human`, describes what a human should check.
   */
  detail: string;
  /**
   * Correlates every entry written by the same recovery run (e.g. a boot's
   * `restartEpoch`, or a reaper day-bucket) so a whole incident can be pulled
   * back with one query (AC3).
   */
  incidentId: string;
  /** Recovery subsystem that recorded the entry, e.g. 'crash-recovery', 'hung-task-reaper'. */
  source: string;
  /** ISO-8601 timestamp the disposition was recorded. */
  at: string;
}

/** A task a recovery path cancelled or degraded, for {@link auditRecoveryDispositions} to check. */
export interface RecoveryDisposedTask {
  taskId: string;
  /** The task's status/outcome after the recovery action, for the audit message. */
  status: string;
}

export interface DispositionAuditOffender {
  taskId: string;
  status: string;
}

export interface DispositionAuditResult {
  windowStartMs: number;
  windowEndMs: number;
  checkedTaskCount: number;
  /** Cancelled/degraded tasks with no disposition entry in the window — the loud finding. */
  offenders: DispositionAuditOffender[];
}

/**
 * Append one disposition entry to the JSONL ledger at `ledgerPath`. Creates
 * the parent directory if needed. Unlike `audit-log.ts`'s `appendAuditRow`
 * (which swallows write failures because the audit row is supplementary),
 * this does NOT swallow: a disposition entry IS the primary evidence AC1
 * requires, so losing one silently would recreate exactly the failure mode
 * issue #1540 exists to close. Callers that must not let a ledger-write
 * failure block the recovery action itself (e.g. the hung-task reaper mid-
 * termination) should catch and log loudly rather than let this swallow.
 */
export async function appendDispositionEntry(ledgerPath: string, entry: DispositionEntry): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

/** Read every entry from the ledger. Missing file reads as empty (nothing has been recorded yet). */
export async function readDispositionEntries(ledgerPath: string): Promise<DispositionEntry[]> {
  let content: string;
  try {
    content = await readFile(ledgerPath, 'utf-8');
  } catch (err) {
    if (isMissingFileError(err)) return [];
    throw err;
  }
  const entries: DispositionEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as DispositionEntry);
    } catch {
      // Self-malformed ledger row — extremely rare, skip rather than fail the read.
    }
  }
  return entries;
}

/** All entries recorded for a given incident (AC3). */
export async function queryDispositionsByIncident(
  ledgerPath: string,
  incidentId: string,
): Promise<DispositionEntry[]> {
  const entries = await readDispositionEntries(ledgerPath);
  return entries.filter((entry) => entry.incidentId === incidentId);
}

/** All entries recorded within `[startMs, endMs]` (AC3). */
export async function queryDispositionsByWindow(
  ledgerPath: string,
  startMs: number,
  endMs: number,
): Promise<DispositionEntry[]> {
  const entries = await readDispositionEntries(ledgerPath);
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at >= startMs && at <= endMs;
  });
}

/**
 * Post-recovery audit (AC2): given the tasks a recovery run just cancelled or
 * degraded, confirm every one of them has a disposition entry recorded in the
 * window. Fails LOUDLY (error-level structured log, see `core/logger.ts`) —
 * never silently — when any are missing, and always returns the offender list
 * so the caller can act on it (surface it in a status read, fail a health
 * check, etc.) instead of the failure being observable only in log scrollback.
 */
export async function auditRecoveryDispositions(
  ledgerPath: string,
  disposedTasks: RecoveryDisposedTask[],
  window: { startMs: number; endMs: number },
): Promise<DispositionAuditResult> {
  const entries = await queryDispositionsByWindow(ledgerPath, window.startMs, window.endMs);
  const disposedIds = new Set(entries.map((entry) => entry.taskId));
  const offenders = disposedTasks
    .filter((task) => !disposedIds.has(task.taskId))
    .map((task) => ({ taskId: task.taskId, status: task.status }));

  if (offenders.length > 0) {
    logger.error('post-recovery audit: cancelled/degraded task(s) missing a disposition entry', {
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      offenderCount: offenders.length,
      offenders,
    });
  }

  return {
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    checkedTaskCount: disposedTasks.length,
    offenders,
  };
}

function isMissingFileError(err: unknown): boolean {
  return err !== null
    && typeof err === 'object'
    && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}
