import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeAgentType } from '../../core/agent-types.js';
import { taskSnapshotRecencyMs, type Task } from '../../core/tasks.js';

/**
 * Durable, append-only terminal-task archive (issue #2765).
 *
 * ## Why this exists
 *
 * `pruneAgedTaskRecords` sheds terminal (completed/cancelled/terminated) task
 * records from the hot store, and the only history carriers before this change
 * were the bounded `tasks.json.daily.*` (7-day) and `tasks.json.predelete.*`
 * (last-5) snapshots. Once both windows roll past a pruned task, its cost/token
 * and completion history is gone. This module adds a *local-first, append-only*
 * archive with an explicit retention/compaction policy and a read path that
 * pages older terminal records WITHOUT hydrating the live task store — so the
 * cost-comparison / history consumers keep working past the snapshot window.
 *
 * ## Layout
 *
 * The archive lives at `<dataDir>/task-archive/` as calendar-month JSONL
 * segments, one record per line:
 *
 *   <dataDir>/task-archive/YYYYMM.jsonl
 *
 * Each line is an {@link ArchivedTaskRecord}: `{ archivedAt, lastActivityMs,
 * task }`. `lastActivityMs` is captured at archive time from
 * {@link taskSnapshotRecencyMs} so paging never has to re-derive it from the
 * task's Date fields.
 *
 * Segmenting by month bounds compaction to whole-file deletes: a segment whose
 * newest record predates the retention horizon is removed in one `unlink`, no
 * rewrite. The current (partial) month is never age-deleted.
 *
 * ## Idempotency & durability
 *
 * Records are appended before the caller deletes them from the store, so a
 * terminal record is archived before it is pruned. A crash between the append
 * and the store delete can re-archive the same task on the next sweep; that is
 * tolerated because the read path and compaction both collapse duplicate task
 * ids keeping the newest `archivedAt`. Append writes each sweep's records in a
 * single `appendFile` call so a batch is not torn across lines.
 *
 * ## Corruption handling
 *
 * A malformed line is skipped (not thrown); an unreadable segment is skipped
 * with a warning. Degraded, partial history is always preferable to a read
 * that throws — the consumers are read-only telemetry.
 */

/** Directory name under the Kookr data dir that holds the archive segments. */
export const TASK_ARCHIVE_DIRNAME = 'task-archive';

/**
 * Records whose owning month segment is entirely older than this many days are
 * compacted away. Chosen well beyond the 7-day snapshot window so archived
 * history genuinely outlives the snapshots (issue #2765 acceptance).
 */
export const DEFAULT_TASK_ARCHIVE_RETENTION_DAYS = 90;

/** Default page size for {@link readArchivedTasks}. */
export const DEFAULT_ARCHIVE_PAGE_LIMIT = 50;

/** Hard ceiling on a single {@link readArchivedTasks} page. */
export const MAX_ARCHIVE_PAGE_LIMIT = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SEGMENT_RE = /^(\d{6})\.jsonl$/;

/** One archived terminal task plus the metadata paging needs. */
export interface ArchivedTaskRecord {
  /** ISO timestamp the record was archived at. */
  archivedAt: string;
  /** Epoch-ms of the task's last activity — the stable paging key. */
  lastActivityMs: number;
  /** The archived terminal task. */
  task: Task;
}

export interface ArchiveTerminalTasksOptions {
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
}

export interface ArchiveTerminalTasksResult {
  /** Number of records appended. */
  archivedCount: number;
  /** Absolute path of the segment written, or undefined when nothing was archived. */
  segmentPath?: string;
}

export interface ReadArchivedTasksQuery {
  /** Only return records with `lastActivityMs < beforeMs` (exclusive). */
  beforeMs?: number;
  /** Continuation cursor from a prior page's {@link ReadArchivedTasksResult.nextCursor}. */
  cursor?: string;
  /** Max records to return. Clamped to [1, {@link MAX_ARCHIVE_PAGE_LIMIT}]. */
  limit?: number;
}

export interface ReadArchivedTasksResult {
  /** Page of records, newest-first (by `lastActivityMs`, then task id). */
  records: ArchivedTaskRecord[];
  /** Opaque cursor for the next (older) page; absent when the page is the last. */
  nextCursor?: string;
  /** Malformed lines skipped while reading (corruption telemetry). */
  skippedLines: number;
}

export interface CompactTaskArchiveOptions {
  /** Retention horizon in days. Defaults to {@link DEFAULT_TASK_ARCHIVE_RETENTION_DAYS}. */
  retentionDays?: number;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
}

export interface CompactTaskArchiveResult {
  /** Segment file names deleted whole (entirely past the retention horizon). */
  removedSegments: string[];
  /** Segment file names rewritten in place to drop duplicate task ids. */
  compactedSegments: string[];
  /** Records dropped (aged-out segment records + collapsed duplicates). */
  removedRecords: number;
}

function segmentName(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}${m}.jsonl`;
}

/**
 * Append terminal task records to the current month's segment.
 *
 * Best-effort `mkdir -p` of the archive dir. All records for the call go out in
 * a single `appendFile` so a sweep's batch is never torn across a partial line.
 * Throws on write failure so the caller can abort a destructive prune before it
 * deletes an un-archived record.
 */
export async function archiveTerminalTasks(
  archiveDir: string,
  tasks: readonly Task[],
  opts: ArchiveTerminalTasksOptions = {},
): Promise<ArchiveTerminalTasksResult> {
  if (tasks.length === 0) return { archivedCount: 0 };
  const now = (opts.now ?? Date.now)();
  const archivedAt = new Date(now).toISOString();

  const lines = tasks.map((task) => {
    const record: ArchivedTaskRecord = {
      archivedAt,
      lastActivityMs: taskSnapshotRecencyMs(task),
      task,
    };
    return JSON.stringify(record);
  });

  await mkdir(archiveDir, { recursive: true });
  const segmentPath = join(archiveDir, segmentName(now));
  await appendFile(segmentPath, `${lines.join('\n')}\n`, 'utf-8');
  return { archivedCount: tasks.length, segmentPath };
}

interface ParsedSegment {
  records: ArchivedTaskRecord[];
  skippedLines: number;
}

/** Parse one segment file into archived records, skipping malformed lines. */
async function parseSegment(path: string): Promise<ParsedSegment> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    console.warn(`[task-archive] skipping unreadable segment ${path}:`, err);
    return { records: [], skippedLines: 0 };
  }

  const records: ArchivedTaskRecord[] = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const record = parseRecordLine(line);
    if (record) {
      records.push(record);
    } else {
      skippedLines += 1;
    }
  }
  return { records, skippedLines };
}

/** Parse and validate one JSONL line; returns undefined for malformed input. */
function parseRecordLine(line: string): ArchivedTaskRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const r = parsed as Partial<ArchivedTaskRecord>;
  if (
    typeof r.archivedAt !== 'string'
    || typeof r.lastActivityMs !== 'number'
    || !Number.isFinite(r.lastActivityMs)
    || !r.task
    || typeof r.task !== 'object'
    || typeof (r.task as Task).id !== 'string'
  ) {
    return undefined;
  }
  return {
    archivedAt: r.archivedAt,
    lastActivityMs: r.lastActivityMs,
    task: reviveTask(r.task as Task, r.lastActivityMs),
  };
}

/** Coerce a persisted date value to a VALID Date, falling back on garbage/missing input. */
function coerceDate(value: unknown, fallbackMs: number): Date {
  const d = new Date(value as string | number | Date);
  return Number.isFinite(d.getTime()) ? d : new Date(fallbackMs);
}

/** Parse an OPTIONAL date; drop it (undefined) when absent or unparseable. */
function coerceOptionalDate(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const d = new Date(value as string | number | Date);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

/**
 * Restore Date objects on a parsed task (mirrors `loadTasks` in
 * task-persistence.ts) so archived records satisfy the {@link Task} contract
 * the same way the snapshot union does.
 *
 * Every Date field is coerced to a VALID Date so a schema-drifted / truncated
 * record can never yield an `Invalid Date`. That matters because downstream
 * consumers call `.toISOString()` on task dates (e.g. `projectTerminalReceipt`
 * on `finishedAt ?? terminatedAt ?? updatedAt`), which throws on an invalid
 * Date — one bad record would otherwise 500 the whole archive read page,
 * defeating the module's corruption-tolerance contract. Required dates fall
 * back to the record's `lastActivityMs`; optional dates (finishedAt/
 * terminatedAt) are dropped when absent or unparseable so the receipt's
 * coalesce lands on a valid Date. `sessions` is normalized to an array so the
 * route's `task.sessions.map(...)` never throws either.
 */
function reviveTask(task: Task, fallbackMs: number): Task {
  const fallback = Number.isFinite(fallbackMs) ? fallbackMs : 0;
  task.agentType = normalizeAgentType(task.agentType);
  task.createdAt = coerceDate(task.createdAt, fallback);
  task.updatedAt = coerceDate(task.updatedAt, fallback);
  task.finishedAt = coerceOptionalDate(task.finishedAt);
  task.terminatedAt = coerceOptionalDate(task.terminatedAt);
  task.sessions = Array.isArray(task.sessions) ? task.sessions : [];
  for (const session of task.sessions) {
    session.agentType = normalizeAgentType(session.agentType);
    session.createdAt = coerceDate(session.createdAt, fallback);
  }
  return task;
}

/** List segment file names (YYYYMM.jsonl) present in the archive dir. */
async function listSegments(archiveDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(archiveDir);
  } catch {
    return [];
  }
  return entries.filter((e) => SEGMENT_RE.test(e));
}

/**
 * Newest-first total order: `lastActivityMs` desc, then task id desc as a
 * stable tiebreak so equal timestamps page deterministically.
 */
function compareNewestFirst(a: ArchivedTaskRecord, b: ArchivedTaskRecord): number {
  if (a.lastActivityMs !== b.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
  return b.task.id < a.task.id ? -1 : b.task.id > a.task.id ? 1 : 0;
}

function encodeCursor(record: ArchivedTaskRecord): string {
  return Buffer.from(`${record.lastActivityMs}:${record.task.id}`, 'utf-8').toString('base64url');
}

function decodeCursor(cursor: string): { lastActivityMs: number; taskId: string } | undefined {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return undefined;
    const lastActivityMs = Number(decoded.slice(0, sep));
    const taskId = decoded.slice(sep + 1);
    if (!Number.isFinite(lastActivityMs) || taskId === '') return undefined;
    return { lastActivityMs, taskId };
  } catch {
    return undefined;
  }
}

/** True when `record` sorts strictly after the cursor position (i.e. is older). */
function isAfterCursor(record: ArchivedTaskRecord, cursor: { lastActivityMs: number; taskId: string }): boolean {
  if (record.lastActivityMs !== cursor.lastActivityMs) return record.lastActivityMs < cursor.lastActivityMs;
  return record.task.id < cursor.taskId;
}

/**
 * Page archived terminal records newest-first, by time and/or opaque cursor.
 *
 * Reads every retained segment (bounded by the retention policy to a handful of
 * month files), collapses duplicate task ids keeping the newest `archivedAt`,
 * then applies the `beforeMs` filter and `cursor` continuation over the total
 * order. It never touches the live task store, satisfying the "retrieve without
 * hydrating the active store" requirement.
 */
export async function readArchivedTasks(
  archiveDir: string,
  query: ReadArchivedTasksQuery = {},
): Promise<ReadArchivedTasksResult> {
  const limit = clampLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

  const segments = await listSegments(archiveDir);
  const latestById = new Map<string, ArchivedTaskRecord>();
  let skippedLines = 0;
  for (const segment of segments) {
    const { records, skippedLines: skipped } = await parseSegment(join(archiveDir, segment));
    skippedLines += skipped;
    for (const record of records) {
      const existing = latestById.get(record.task.id);
      // Newest archivedAt wins; ties fall to the last-read copy (later segment).
      if (!existing || record.archivedAt >= existing.archivedAt) {
        latestById.set(record.task.id, record);
      }
    }
  }

  let all = Array.from(latestById.values());
  if (query.beforeMs !== undefined) {
    all = all.filter((r) => r.lastActivityMs < query.beforeMs!);
  }
  if (cursor) {
    all = all.filter((r) => isAfterCursor(r, cursor));
  }
  all.sort(compareNewestFirst);

  const page = all.slice(0, limit);
  const hasMore = all.length > limit;
  return {
    records: page,
    ...(hasMore && page.length > 0 ? { nextCursor: encodeCursor(page[page.length - 1]) } : {}),
    skippedLines,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ARCHIVE_PAGE_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_ARCHIVE_PAGE_LIMIT) return MAX_ARCHIVE_PAGE_LIMIT;
  return floored;
}

/**
 * Apply the retention/compaction policy:
 *  - delete whole segments whose month ends before the retention horizon;
 *  - rewrite any surviving segment that carries duplicate task ids so physical
 *    duplicates (from crash re-archive) do not accumulate unbounded.
 *
 * Idempotent: on an already-compact archive it removes nothing and rewrites
 * nothing. Best-effort per segment — one failing segment never aborts the rest.
 */
export async function compactTaskArchive(
  archiveDir: string,
  opts: CompactTaskArchiveOptions = {},
): Promise<CompactTaskArchiveResult> {
  const now = (opts.now ?? Date.now)();
  const retentionDays = opts.retentionDays ?? DEFAULT_TASK_ARCHIVE_RETENTION_DAYS;
  const horizonMs = now - retentionDays * MS_PER_DAY;
  const currentSegment = segmentName(now);

  const result: CompactTaskArchiveResult = {
    removedSegments: [],
    compactedSegments: [],
    removedRecords: 0,
  };

  for (const segment of await listSegments(archiveDir)) {
    const path = join(archiveDir, segment);

    // Whole-segment age delete: a month whose FIRST day starts on or after the
    // horizon is retained. The current month is never age-deleted. We age by
    // the end of the segment's month so a segment is only dropped once every
    // record it could hold is guaranteed past the horizon.
    if (segment !== currentSegment && monthEndMs(segment) < horizonMs) {
      const { records } = await parseSegment(path);
      try {
        await unlink(path);
        result.removedSegments.push(segment);
        result.removedRecords += records.length;
      } catch (err) {
        console.warn(`[task-archive] failed to remove aged segment ${path}:`, err);
      }
      continue;
    }

    // Duplicate compaction: rewrite in place only when a segment actually
    // carries more than one line per task id.
    const { records } = await parseSegment(path);
    const deduped = dedupeRecords(records);
    if (deduped.length === records.length) continue;

    try {
      await rewriteSegment(path, deduped);
      result.compactedSegments.push(segment);
      result.removedRecords += records.length - deduped.length;
    } catch (err) {
      console.warn(`[task-archive] failed to compact segment ${path}:`, err);
    }
  }

  return result;
}

/** Epoch-ms of the first instant AFTER the segment's calendar month. */
function monthEndMs(segment: string): number {
  const match = SEGMENT_RE.exec(segment);
  if (!match) return Number.POSITIVE_INFINITY; // unknown shape — never age-delete
  const stamp = match[1];
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6)); // 1-12
  // Date rolls month 12 → next January automatically via month index (0-based).
  return new Date(year, month, 1).getTime();
}

/** Collapse duplicate task ids keeping the newest `archivedAt`; preserve order. */
function dedupeRecords(records: ArchivedTaskRecord[]): ArchivedTaskRecord[] {
  const latestById = new Map<string, ArchivedTaskRecord>();
  for (const record of records) {
    const existing = latestById.get(record.task.id);
    if (!existing || record.archivedAt >= existing.archivedAt) {
      latestById.set(record.task.id, record);
    }
  }
  return Array.from(latestById.values());
}

/** Atomically replace a segment with the given records (temp file + rename). */
async function rewriteSegment(path: string, records: ArchivedTaskRecord[]): Promise<void> {
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, records.length > 0 ? `${body}\n` : '', 'utf-8');
  await rename(tmp, path);
}

/** Best-effort archived-record count across all segments (diagnostics/tests). */
export async function countArchivedTasks(archiveDir: string): Promise<number> {
  let total = 0;
  for (const segment of await listSegments(archiveDir)) {
    const { records } = await parseSegment(join(archiveDir, segment));
    total += records.length;
  }
  return total;
}
