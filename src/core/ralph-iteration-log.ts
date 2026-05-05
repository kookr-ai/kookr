import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Append-only audit trail for Ralph iteration cycles. One JSONL line per
 * iteration. The file lives at `<task-dir>/ralph-iterations.jsonl` so it
 * travels with the task workspace (issue #440, open question Q3 — default
 * per-task-dir; centralised location is a future refinement).
 *
 * This module is pure I/O — it is the writer's responsibility to construct
 * the record. It deliberately knows nothing about the loop state machine,
 * so the controller can be tested without touching the filesystem.
 */

/** Why an iteration ended. Used by readers to render iteration tables. */
export type RalphIterationExitReason =
  /** Predicate exited zero — loop should stop. */
  | 'predicate_satisfied'
  /** Predicate timed out (5s default) — controller chose to keep looping. */
  | 'predicate_timeout'
  /** Iteration cap reached. */
  | 'iteration_cap'
  /** User cancelled via UI / API. */
  | 'cancelled'
  /** User paused via UI / API. */
  | 'paused'
  /** Kookr crashed mid-iteration; reconciled on restart. */
  | 'kookr_crash'
  /** Agent session died. */
  | 'session_dead'
  /** Predicate process error (spawn failure, exec error). */
  | 'predicate_error'
  /** Iteration ran to completion and the next one was injected. */
  | 'continued';

export interface RalphIterationDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface RalphIterationRecord {
  iterationNumber: number;
  startedAt: number;
  endedAt: number;
  exitReason: RalphIterationExitReason;
  /**
   * Best-effort cost from the Stop-hook event payload. `null` (not omitted)
   * when the source is unavailable, so readers can distinguish "free" from
   * "unknown". Cost-cap stop conditions must fail closed when this is null.
   */
  cumulativeCostUsd: number | null;
  /**
   * Git ref captured at iteration start (`ralph/iter-<N>-start` tag). `null`
   * when tag creation failed (not a repo, detached HEAD, broken index).
   */
  gitBaselineRef: string | null;
  /**
   * Diff against `gitBaselineRef` at iteration end. `null` when either the
   * baseline ref is null or the diff command failed. Distinct from
   * `{filesChanged: 0, insertions: 0, deletions: 0}` ("no changes"); a null
   * here must be treated as "data unavailable" by convergence detection.
   */
  diffStats: RalphIterationDiffStats | null;
}

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
