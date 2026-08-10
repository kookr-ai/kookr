import { createReadStream } from 'node:fs';
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { RalphLoopState } from './tasks.js';
import type {
  RalphIterationDiffStats,
  RalphIterationExitReason,
  RalphIterationLogReadModel,
  RalphIterationRecord,
  RalphIterationVerdict,
} from '../shared/contracts/ralph-iteration-log.js';
export type {
  RalphIterationDiffStats,
  RalphIterationExitReason,
  RalphIterationLogReadModel,
  RalphIterationLogSummary,
  RalphIterationRecord,
  RalphIterationVerdict,
} from '../shared/contracts/ralph-iteration-log.js';

/**
 * Append-only audit trail for Ralph iteration cycles. One JSONL line per
 * iteration. The file lives at `<task-dir>/ralph-iterations.jsonl` so it
 * travels with the task workspace (issue #440, open question Q3 — default
 * per-task-dir; centralised location is a future refinement).
 *
 * This module owns the append/read/export helpers for the audit log. It is
 * the writer's responsibility to construct the record, and this code
 * deliberately knows nothing about the loop state machine so the controller
 * can be tested without touching the filesystem.
 */

export const DEFAULT_RALPH_ITERATION_READ_LIMIT = 200;
export const MAX_RALPH_ITERATION_READ_LIMIT = 1000;

const EXIT_REASONS: ReadonlySet<RalphIterationExitReason> = new Set([
  'predicate_satisfied',
  'predicate_timeout',
  'iteration_cap',
  'zero_diff_convergence',
  'cost_cap',
  'cancelled',
  'paused',
  'kookr_crash',
  'session_dead',
  'predicate_error',
  'continued',
  'target_stalled',
  'all_targets_stalled',
  'iteration_cost_cap',
  'replaced_by_user',
  'first_hook_miss',
  'unknown',
]);

/**
 * Append one iteration record to `<taskDir>/ralph-iterations.jsonl`. Creates
 * the parent directory if it doesn't exist. Single trailing newline so the
 * file is valid JSONL even when read line-by-line.
 *
 * Not atomic — concurrent writers to the same file from the same process
 * could interleave. The controller is single-threaded per task so this is
 * acceptable; cross-process concurrency would require flock and is out of
 * scope for the foundation slice.
 */
export async function appendIterationRecord(
  taskDir: string,
  record: RalphIterationRecord,
): Promise<void> {
  const filePath = iterationLogPath(taskDir);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

/** Resolve the iteration log path for a given task workspace. */
export function iterationLogPath(taskDir: string): string {
  return `${taskDir.replace(/\/+$/, '')}/ralph-iterations.jsonl`;
}

export function parseIterationRecord(line: string): RalphIterationRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const { iterationNumber, startedAt, endedAt, exitReason, cumulativeCostUsd, gitBaselineRef, diffStats, verdict, costDeltaUsd } = obj;
  if (typeof iterationNumber !== 'number' || !Number.isInteger(iterationNumber)) return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return null;
  if (typeof exitReason !== 'string') return null;
  if (cumulativeCostUsd !== null && (typeof cumulativeCostUsd !== 'number' || !Number.isFinite(cumulativeCostUsd))) return null;
  if (gitBaselineRef !== null && typeof gitBaselineRef !== 'string') return null;
  if (diffStats !== null && !isDiffStats(diffStats)) return null;

  // Forward-compat: unknown exit reasons emitted by a newer Kookr writer are
  // mapped to 'unknown' instead of dropping the row entirely. Older readers
  // on newer logs surface these as iterations rather than as malformed lines.
  const normalizedExitReason: RalphIterationExitReason =
    EXIT_REASONS.has(exitReason as RalphIterationExitReason)
      ? (exitReason as RalphIterationExitReason)
      : 'unknown';

  const record: RalphIterationRecord = {
    iterationNumber,
    startedAt,
    endedAt,
    exitReason: normalizedExitReason,
    cumulativeCostUsd,
    gitBaselineRef,
    diffStats,
  };

  // Optional fields — silently dropped if malformed (forward-compat for older
  // logs written before these fields existed). Adding fields is additive;
  // never reject a record that's valid in the legacy schema.
  if (verdict !== undefined && isValidVerdict(verdict)) {
    record.verdict = verdict;
  }
  if (costDeltaUsd === null) {
    record.costDeltaUsd = null;
  } else if (typeof costDeltaUsd === 'number' && Number.isFinite(costDeltaUsd)) {
    record.costDeltaUsd = costDeltaUsd;
  }

  return record;
}

function isValidVerdict(value: unknown): value is RalphIterationVerdict {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.iteration !== 'number' || !Number.isInteger(obj.iteration)) return false;
  switch (obj.verdict) {
    case 'progress':
      return (obj.target === undefined || typeof obj.target === 'string')
        && (obj.targetTitle === undefined || typeof obj.targetTitle === 'string')
        && (obj.reason === undefined || typeof obj.reason === 'string');
    case 'complete':
      return obj.reason === undefined || typeof obj.reason === 'string';
    case 'stalled':
      if (typeof obj.target !== 'string' || obj.target.length === 0) return false;
      if (obj.targetTitle !== undefined && typeof obj.targetTitle !== 'string') return false;
      if (typeof obj.reason !== 'string') return false;
      if (obj.blockers !== undefined) {
        if (!Array.isArray(obj.blockers)) return false;
        if (!obj.blockers.every((b) => typeof b === 'string')) return false;
      }
      return true;
    default:
      return false;
  }
}

export async function readIterationLog(
  taskDir: string,
  opts: { limit?: number; loop?: RalphLoopState } = {},
): Promise<RalphIterationLogReadModel> {
  const limit = clampReadLimit(opts.limit);
  const filePath = iterationLogPath(taskDir);
  const iterations: RalphIterationRecord[] = [];
  let totalIterations = 0;
  let malformedLines = 0;
  let firstStartedAt: number | null = null;
  let latest: RalphIterationRecord | null = null;
  let cumulativeDurationMs = 0;
  let durationCount = 0;

  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const record = parseIterationRecord(line);
      if (!record) {
        malformedLines += 1;
        continue;
      }

      totalIterations += 1;
      firstStartedAt ??= record.startedAt;
      latest = record;
      const duration = record.endedAt - record.startedAt;
      if (Number.isFinite(duration) && duration >= 0) {
        cumulativeDurationMs += duration;
        durationCount += 1;
      }
      iterations.push(record);
      if (iterations.length > limit) iterations.shift();
    }
  } catch (err) {
    if (isMissingFileError(err)) return emptyReadModel(limit);
    throw err;
  }

  const averageIterationDurationMs = durationCount > 0 ? cumulativeDurationMs / durationCount : null;
  const endedAt = latest?.endedAt ?? null;
  const runtimeMs = firstStartedAt !== null && endedAt !== null ? Math.max(0, endedAt - firstStartedAt) : null;
  const etaMs = computeEtaMs(opts.loop, totalIterations, averageIterationDurationMs);
  return {
    iterations,
    summary: {
      totalIterations,
      returnedIterations: iterations.length,
      capped: totalIterations > limit,
      malformedLines,
      latestExitReason: latest?.exitReason ?? null,
      cumulativeCostUsd: latest?.cumulativeCostUsd ?? null,
      startedAt: firstStartedAt,
      endedAt,
      runtimeMs,
      averageIterationDurationMs,
      etaMs,
    },
  };
}

export function formatIterationLogCsv(model: RalphIterationLogReadModel): string {
  const rows = [
    [
      'iterationNumber',
      'startedAt',
      'endedAt',
      'durationMs',
      'exitReason',
      'target',
      'targetTitle',
      'verdictReason',
      'cumulativeCostUsd',
      'gitBaselineRef',
      'diffFilesChanged',
      'diffInsertions',
      'diffDeletions',
    ],
    ...model.iterations.map((record) => [
      String(record.iterationNumber),
      formatTimestamp(record.startedAt),
      formatTimestamp(record.endedAt),
      String(Math.max(0, record.endedAt - record.startedAt)),
      record.exitReason,
      record.verdict && 'target' in record.verdict ? record.verdict.target ?? '' : '',
      record.verdict && 'targetTitle' in record.verdict ? record.verdict.targetTitle ?? '' : '',
      record.verdict?.reason ?? '',
      record.cumulativeCostUsd === null ? '' : String(record.cumulativeCostUsd),
      record.gitBaselineRef ?? '',
      record.diffStats === null ? '' : String(record.diffStats.filesChanged),
      record.diffStats === null ? '' : String(record.diffStats.insertions),
      record.diffStats === null ? '' : String(record.diffStats.deletions),
    ]),
  ];
  return `${rows.map((row) => row.map(escapeCsvField).join(',')).join('\n')}\n`;
}

function clampReadLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RALPH_ITERATION_READ_LIMIT;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_RALPH_ITERATION_READ_LIMIT;
  }
  return Math.min(limit, MAX_RALPH_ITERATION_READ_LIMIT);
}

function computeEtaMs(
  loop: RalphLoopState | undefined,
  totalIterations: number,
  averageIterationDurationMs: number | null,
): number | null {
  if (!loop || loop.status !== 'running') return null;
  if (averageIterationDurationMs === null) return null;
  const observedIterations = Math.max(totalIterations, loop.currentIteration);
  const remaining = loop.iterationCap - observedIterations;
  if (remaining <= 0) return null;
  return remaining * averageIterationDurationMs;
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function escapeCsvField(value: string): string {
  const spreadsheetSafeValue = neutralizeSpreadsheetFormula(value);
  if (!/[",\n\r]/.test(spreadsheetSafeValue)) return spreadsheetSafeValue;
  return `"${spreadsheetSafeValue.replaceAll('"', '""')}"`;
}

function neutralizeSpreadsheetFormula(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

function isDiffStats(value: unknown): value is RalphIterationDiffStats {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Number.isFinite(obj.filesChanged)
    && Number.isInteger(obj.filesChanged)
    && Number.isFinite(obj.insertions)
    && Number.isInteger(obj.insertions)
    && Number.isFinite(obj.deletions)
    && Number.isInteger(obj.deletions);
}

function emptyReadModel(limit: number): RalphIterationLogReadModel {
  return {
    iterations: [],
    summary: {
      totalIterations: 0,
      returnedIterations: 0,
      capped: false,
      malformedLines: 0,
      latestExitReason: null,
      cumulativeCostUsd: null,
      startedAt: null,
      endedAt: null,
      runtimeMs: null,
      averageIterationDurationMs: null,
      etaMs: null,
    },
  };
}

function isMissingFileError(err: unknown): boolean {
  return err !== null
    && typeof err === 'object'
    && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}
