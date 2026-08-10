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
  /** Agent reported `verdict: stalled` for a single target; for single-target
   *  loops this is also the terminal exit reason once the threshold is reached. */
  | 'target_stalled'
  /** Multi-target loop with all `declaredTargets` burned. Loop stops cleanly. */
  | 'all_targets_stalled'
  /** Per-iteration cost cap exceeded for `consecutiveIterationCostCapHits` in a row. */
  | 'iteration_cost_cap'
  /** User replaced the loop with a fresh one via the UI conflict dialog. */
  | 'replaced_by_user'
  /**
   * First-hook miss reaper terminated the iteration session before any agent
   * hook arrived (issue #2193). Distinct from {@link kookr_crash} (process
   * restart) and {@link session_dead} (runtime death after ack).
   */
  | 'first_hook_miss'
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

/**
 * Discriminated union written by the agent to `$RALPH_VERDICT_FILE`.
 * See `rfc-ralph-loop-stall-handling.md` §1.
 */
export type RalphIterationVerdict =
  | { verdict: 'progress'; iteration: number; target?: string; targetTitle?: string; reason?: string }
  | { verdict: 'complete'; iteration: number; reason?: string }
  | {
      verdict: 'stalled';
      iteration: number;
      target: string;
      targetTitle?: string;
      reason: string;
      blockers?: string[];
      /**
       * Agent's claim that this target is structurally unfit and retrying it
       * cannot help (e.g. umbrella tracking issue, malformed issue body,
       * unrecoverable worktree collision). When true, the engine burns the
       * target at consecutiveStallCount=1 instead of waiting for the
       * `consecutiveStallsPerTarget` threshold; for single-target loops it
       * also terminates immediately with `target_stalled`. Use sparingly —
       * transient blockers (CI red, claim contention, network 5xx) MUST NOT
       * set this; the count-based threshold exists to absorb those.
       */
      permanent?: boolean;
    };

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
  /**
   * Optional verdict copied from the agent's `RALPH_VERDICT_FILE` for this
   * iteration. Absent when the agent did not write a verdict, or when the
   * file was malformed/oversize/wrong-iteration (recorded as a verdict
   * warning instead — see `RalphLoopState.verdictWarningCount`).
   */
  verdict?: RalphIterationVerdict;
  /**
   * Per-iteration cost delta in USD, computed at Stop time as
   * `cumulativeCostUsd - prevCumulativeCostUsd`. `null` when the source is
   * unavailable. Used by the per-iteration cost cap check.
   */
  costDeltaUsd?: number | null;
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
