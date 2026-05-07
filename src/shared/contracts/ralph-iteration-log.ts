/** Why an iteration ended. Used by readers to render iteration tables. */
export type RalphIterationExitReason =
  /** Predicate exited zero; loop should stop. */
  | 'predicate_satisfied'
  /** Predicate timed out; controller chose to keep looping. */
  | 'predicate_timeout'
  /** Iteration cap reached. */
  | 'iteration_cap'
  /** Zero-diff convergence streak reached. */
  | 'zero_diff_convergence'
  /** Best-effort cumulative cost reached the configured USD cap. */
  | 'cost_cap'
  /** User cancelled via UI / API. */
  | 'cancelled'
  /** User paused via UI / API. */
  | 'paused'
  /** Kookr crashed mid-iteration; reconciled on restart. */
  | 'kookr_crash'
  /** Agent session died. */
  | 'session_dead'
  /** Predicate process error, spawn failure, or exec error. */
  | 'predicate_error'
  /** Iteration ran to completion and the next one was injected. */
  | 'continued'
  /** User replaced the loop with a fresh one via the UI conflict dialog. */
  | 'replaced_by_user'
  /**
   * Forward-compat fallback for exit reasons emitted by a newer Kookr that
   * this reader doesn't recognize. `parseIterationRecord` maps unknown
   * strings to this value so rows are not silently dropped.
   */
  | 'unknown';

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
   * Best-effort cost from the Stop-hook event payload. `null` means source
   * unavailable, distinct from a known zero cost.
   */
  cumulativeCostUsd: number | null;
  /**
   * Git ref captured at iteration start (`ralph/iter-<N>-start` tag). `null`
   * when tag creation failed.
   */
  gitBaselineRef: string | null;
  /**
   * Diff against `gitBaselineRef` at iteration end. `null` means data
   * unavailable, distinct from zero changed files.
   */
  diffStats: RalphIterationDiffStats | null;
}

export interface RalphIterationLogSummary {
  totalIterations: number;
  returnedIterations: number;
  capped: boolean;
  malformedLines: number;
  latestExitReason: RalphIterationExitReason | null;
  cumulativeCostUsd: number | null;
  startedAt: number | null;
  endedAt: number | null;
  runtimeMs: number | null;
  averageIterationDurationMs: number | null;
  etaMs: number | null;
}

export interface RalphIterationLogReadModel {
  iterations: RalphIterationRecord[];
  summary: RalphIterationLogSummary;
}
