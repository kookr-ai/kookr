import type { Task, TaskStore, RalphLoopState, BurnedOutTarget } from './tasks.js';
import { runStopPredicate, type PredicateResult } from './ralph-predicate.js';
import { createBaselineTag, computeDiffStats } from './ralph-git-baseline.js';
import {
  appendIterationRecord,
  type RalphIterationExitReason,
  type RalphIterationDiffStats,
  type RalphIterationRecord,
  type RalphIterationVerdict,
} from './ralph-iteration-log.js';
import { canonicalizeTarget } from './ralph-iteration-verdict.js';
import { resolveStallConfig } from '../shared/contracts/ralph.js';

/**
 * Per-Stop controller for Ralph Wiggum iteration loops (issue #440).
 *
 * Pure-computation contract: the cycler does no FS / network IO directly. The
 * service layer parses the verdict file, computes the per-iteration cost
 * delta, and passes both via `RalphCyclerHandleStopOptions`. The cycler
 * decides what to do, persists the iteration record (via the IO seam), and
 * returns an action plus any pending interaction-log events the service
 * layer should fire.
 *
 * Decision order (cheapest-first, see `rfc-ralph-loop-stall-handling.md` §4):
 *   1. terminal/paused          → noop
 *   2. iteration cap            → terminate(iteration_cap)
 *   3. apply decay              → un-burn any target whose lastAttemptedIteration is stale
 *   4. stopPredicate exit 0     → terminate(predicate_satisfied)
 *   5. verdict.complete + predicate compatible → terminate(predicate_satisfied)
 *   6. verdict.complete + predicate exit≠0 (clean) → continue + predicate_disagree event
 *   7. verdict.stalled OR stallPredicate exit 0 → record stall, check thresholds
 *      - single-target: stallCount ≥ N → terminate(target_stalled)
 *      - multi-target with all declaredTargets burned → terminate(all_targets_stalled)
 *      - else → continue, iteration recorded as target_stalled
 *   8. iteration cost-cap consecutive ≥ N → terminate(iteration_cost_cap)
 *   9. cumulative cost cap      → terminate(cost_cap)
 *  10. zero-diff convergence    → terminate(zero_diff_convergence)
 *  11. else                     → continue
 *
 * `verdict.progress` does not by itself terminate; it un-burns its target as a
 * side effect before the rest of the chain runs.
 */

/**
 * Interaction-log events the cycler decides should fire. The service layer
 * actually appends them (the cycler stays IO-free for testability).
 */
export type RalphCyclerEvent =
  | {
      type: 'ralph_predicate_disagree';
      taskId: string;
      iteration: number;
      predicateExitCode: number;
    }
  | {
      type: 'ralph_target_burned';
      taskId: string;
      target: string;
      iteration: number;
      stallCount: number;
      reason: string;
    }
  | {
      type: 'ralph_target_unburned';
      taskId: string;
      target: string;
      iteration: number;
      via: 'progress_verdict' | 'patch_burned_targets' | 'decay';
    }
  | {
      type: 'ralph_iteration_cost_warning';
      taskId: string;
      iteration: number;
      costDeltaUsd: number;
      capUsd: number;
      consecutiveStreak: number;
    };

/** Action returned to the caller. */
export type RalphCyclerAction =
  | { kind: 'launch_fresh'; taskId: string; text: string; events: RalphCyclerEvent[] }
  | { kind: 'terminate'; reason: RalphIterationExitReason; events: RalphCyclerEvent[] }
  | { kind: 'noop'; events: RalphCyclerEvent[] };

export interface RalphCyclerHandleStopOptions {
  /** Task ID emitting Stop. */
  taskId: string;
  /** Terminal session id that emitted the Stop event. */
  sessionId: string;
  /**
   * Cumulative cost for this iteration, best-effort from the Stop hook event.
   * `null` (not omitted) when the source is unavailable so readers can tell
   * "free" from "unknown" — see issue #440 §"Cost source".
   *
   * The cycler computes the per-iteration delta as
   * `cumulativeCostUsd - loop.lastCumulativeCostUsd` (when both known) and
   * persists it on the iteration record. After append, the cycler updates
   * `loop.lastCumulativeCostUsd` so the NEXT iteration's delta is correct.
   */
  cumulativeCostUsd?: number | null;
  /**
   * Parsed verdict file for this iteration, or undefined when the agent did
   * not write one (or the file was malformed and the service layer logged a
   * warning). Cycler treats undefined as legacy `continued`.
   */
  verdict?: RalphIterationVerdict;
  /**
   * Optional path to the just-finished agent turn's output, exposed to the
   * predicate as `$RALPH_LAST_OUTPUT_FILE`.
   */
  lastOutputFile?: string;
  /** Override clock for tests. */
  now?: number;
}

export interface RalphCyclerIO {
  runPredicate: typeof runStopPredicate;
  createBaselineTag: typeof createBaselineTag;
  computeDiffStats: typeof computeDiffStats;
  appendIterationRecord: typeof appendIterationRecord;
}

const DEFAULT_IO: RalphCyclerIO = {
  runPredicate: runStopPredicate,
  createBaselineTag,
  computeDiffStats,
  appendIterationRecord,
};

export class RalphCycler {
  constructor(private readonly io: RalphCyclerIO = DEFAULT_IO) {}

  async handleStop(
    taskStore: TaskStore,
    opts: RalphCyclerHandleStopOptions,
  ): Promise<RalphCyclerAction> {
    const events: RalphCyclerEvent[] = [];
    const task = taskStore.getTask(opts.taskId);
    if (!task) return { kind: 'noop', events };
    const loop = task.ralphLoop;
    if (!loop) return { kind: 'noop', events };
    if (loop.status !== 'running') return { kind: 'noop', events };

    const now = opts.now ?? Date.now();
    const startedAt = loop.lastIterationStartedAt > 0 ? loop.lastIterationStartedAt : now;
    const stallConfig = resolveStallConfig(loop.stallConfig);
    const verdict = opts.verdict;
    const cost = opts.cumulativeCostUsd ?? null;
    // Compute per-iteration cost delta from state; null when either bound is
    // unknown (first iteration after a fresh attach, or cost source absent).
    const costDelta = computeCostDelta(cost, loop.lastCumulativeCostUsd);

    // 1. iteration cap (always-checked, separate from predicate).
    if (loop.currentIteration >= loop.iterationCap) {
      await this.finishIteration(task, loop, {
        startedAt, endedAt: now, exitReason: 'iteration_cap',
        cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
      });
      this.terminate(loop, 'completed');
      return { kind: 'terminate', reason: 'iteration_cap', events };
    }

    // 2. apply decay BEFORE stall checks, so a freshly-decayed target can be
    //    re-burned in the same iteration if the agent reports it stalled again.
    this.applyDecay(loop, stallConfig, opts.taskId, events);

    // 3. predicate (slow check). Failures keep the loop alive.
    let predicateOutcome: PredicateResult | null = null;
    if (loop.stopPredicate) {
      predicateOutcome = await this.io.runPredicate(loop.stopPredicate, {
        cwd: task.cwd,
        iteration: loop.currentIteration,
        lastOutputFile: opts.lastOutputFile,
      });
      if (predicateOutcome.satisfied) {
        await this.finishIteration(task, loop, {
          startedAt, endedAt: now, exitReason: 'predicate_satisfied',
          cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
        });
        this.terminate(loop, 'completed');
        return { kind: 'terminate', reason: 'predicate_satisfied', events };
      }
    }

    // 4. verdict.complete handling per the predicate-vs-verdict matrix.
    if (verdict?.verdict === 'complete') {
      // Predicate clean exit≠0 (not error/timeout) blocks the agent's
      // self-declared completion. The loop continues and the disagreement is
      // surfaced as an interaction-log event.
      const predicateExplicitlyDisagrees =
        predicateOutcome !== null
        && !predicateOutcome.satisfied
        && !predicateOutcome.timedOut
        && !predicateOutcome.errored;
      if (predicateExplicitlyDisagrees) {
        events.push({
          type: 'ralph_predicate_disagree',
          taskId: opts.taskId,
          iteration: loop.currentIteration,
          predicateExitCode: predicateOutcome!.exitCode ?? -1,
        });
        // Fall through to the `continue` branch below — the predicate's
        // disagreement is the load-bearing signal.
      } else {
        // No predicate, or predicate matched, or predicate failed (error/
        // timeout — can't tell us either way). Trust the agent.
        await this.finishIteration(task, loop, {
          startedAt, endedAt: now, exitReason: 'predicate_satisfied',
          cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
        });
        this.terminate(loop, 'completed');
        return { kind: 'terminate', reason: 'predicate_satisfied', events };
      }
    }

    // 5. progress verdict un-burns its target before stall checks below.
    //    A `progress` for the same target an iteration recently reported
    //    `stalled` for is the agent saying "made it through this time."
    if (verdict?.verdict === 'progress' && verdict.target) {
      this.unburnTarget(loop, canonicalizeTarget(verdict.target), 'progress_verdict', opts.taskId, events);
    }

    // 6. stall handling. Sources: agent verdict.stalled (richer), or
    //    stallPredicate exit 0 (engine-only fallback). Verdict wins when both
    //    fire — it carries target attribution. The stallPredicate is only
    //    evaluated when no verdict.stalled was supplied.
    let stallTarget: string | undefined;
    let stallReason: string | undefined;
    let stallBlockers: string[] = [];

    if (verdict?.verdict === 'stalled') {
      stallTarget = canonicalizeTarget(verdict.target);
      stallReason = verdict.reason;
      stallBlockers = verdict.blockers ?? [];
    } else if (loop.stallPredicate) {
      const stallOutcome = await this.io.runPredicate(loop.stallPredicate, {
        cwd: task.cwd,
        iteration: loop.currentIteration,
        lastOutputFile: opts.lastOutputFile,
      });
      if (stallOutcome.satisfied) {
        // No target attribution from a shell predicate. Single-target loops
        // get a synthetic key so the threshold can fire; multi-target loops
        // accumulate a generic stall row that persists across iterations.
        stallTarget = '__stall_predicate__';
        stallReason = 'stallPredicate exited 0';
      }
    }

    if (stallTarget !== undefined) {
      const burned = this.recordStall(loop, stallTarget, stallReason ?? '', stallBlockers, stallConfig, opts.taskId, events);
      // Single-target termination check: when the loop is declared
      // single-target and any one target reaches its termination threshold,
      // terminate the loop.
      if (
        stallConfig.loopShape === 'single-target'
        && burned.consecutiveStallCount >= stallConfig.consecutiveStallsForSingleTargetTermination
      ) {
        await this.finishIteration(task, loop, {
          startedAt, endedAt: now, exitReason: 'target_stalled',
          cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
        });
        this.terminate(loop, 'completed');
        return { kind: 'terminate', reason: 'target_stalled', events };
      }
      // Multi-target all-burned check.
      if (
        stallConfig.loopShape === 'multi-target'
        && stallConfig.declaredTargets
        && stallConfig.declaredTargets.length > 0
        && this.allDeclaredBurned(loop, stallConfig.declaredTargets)
      ) {
        await this.finishIteration(task, loop, {
          startedAt, endedAt: now, exitReason: 'all_targets_stalled',
          cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
        });
        this.terminate(loop, 'completed');
        return { kind: 'terminate', reason: 'all_targets_stalled', events };
      }
    }

    // 7. iteration cost cap (decoupled from stall semantics — has its own
    //    counter, threshold, exit reason, and warning event). See
    //    rfc-ralph-loop-stall-handling.md §6.
    const iterationCostCap = stallConfig.iterationCostCapUsd;
    if (iterationCostCap !== undefined && costDelta !== null && costDelta > iterationCostCap) {
      const streak = (loop.consecutiveIterationCostCapStreak ?? 0) + 1;
      loop.consecutiveIterationCostCapStreak = streak;
      loop.iterationCostWarningCount = (loop.iterationCostWarningCount ?? 0) + 1;
      events.push({
        type: 'ralph_iteration_cost_warning',
        taskId: opts.taskId,
        iteration: loop.currentIteration,
        costDeltaUsd: costDelta,
        capUsd: iterationCostCap,
        consecutiveStreak: streak,
      });
      if (streak >= stallConfig.consecutiveIterationCostCapHits) {
        await this.finishIteration(task, loop, {
          startedAt, endedAt: now, exitReason: 'iteration_cost_cap',
          cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
        });
        this.terminate(loop, 'completed');
        return { kind: 'terminate', reason: 'iteration_cost_cap', events };
      }
    } else if (iterationCostCap !== undefined && costDelta !== null) {
      // Within-cap iteration: reset streak.
      loop.consecutiveIterationCostCapStreak = 0;
    }

    const diff = await this.computeIterationDiff(task, loop);
    const nextZeroDiffStreak = nextZeroDiffStreakFor(loop, diff.diffStats);

    // 8. cumulative cost cap (existing behavior).
    if (isCostCapReached(loop, cost)) {
      loop.zeroDiffStreak = nextZeroDiffStreak;
      await this.appendFinishedIteration(task, loop, {
        startedAt, endedAt: now, exitReason: 'cost_cap',
        cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
        gitBaselineRef: diff.gitBaselineRef, diffStats: diff.diffStats,
      });
      this.terminate(loop, 'completed');
      task.updatedAt = new Date(now);
      return { kind: 'terminate', reason: 'cost_cap', events };
    }

    // 9. zero-diff convergence (existing).
    if (isZeroDiffConverged(loop, nextZeroDiffStreak)) {
      loop.zeroDiffStreak = nextZeroDiffStreak;
      await this.appendFinishedIteration(task, loop, {
        startedAt, endedAt: now, exitReason: 'zero_diff_convergence',
        cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
        gitBaselineRef: diff.gitBaselineRef, diffStats: diff.diffStats,
      });
      this.terminate(loop, 'completed');
      task.updatedAt = new Date(now);
      return { kind: 'terminate', reason: 'zero_diff_convergence', events };
    }

    // 10. continue. The iteration's exit reason reflects what happened:
    //     stall recorded but threshold not yet reached → 'target_stalled';
    //     predicate timed out / errored → preserved;
    //     otherwise → 'continued'.
    const exitReason: RalphIterationExitReason =
      stallTarget !== undefined ? 'target_stalled'
      : predicateOutcome?.timedOut ? 'predicate_timeout'
      : predicateOutcome?.errored ? 'predicate_error'
      : 'continued';

    loop.zeroDiffStreak = nextZeroDiffStreak;
    await this.appendFinishedIteration(task, loop, {
      startedAt, endedAt: now, exitReason,
      cumulativeCostUsd: cost, costDeltaUsd: costDelta, verdict,
      gitBaselineRef: diff.gitBaselineRef, diffStats: diff.diffStats,
    });

    const nextIteration = loop.currentIteration + 1;
    loop.currentIteration = nextIteration;
    loop.cumulativeIterations += 1;
    loop.lastIterationStartedAt = now;
    task.updatedAt = new Date(now);

    void this.io.createBaselineTag(nextIteration, { cwd: task.cwd });

    return { kind: 'launch_fresh', taskId: task.id, text: loop.prompt, events };
  }

  /**
   * Record one stall against the canonicalized target. Updates per-target
   * counters, sets `burned: true` when the threshold is crossed, and emits a
   * `ralph_target_burned` event on the burn transition. Returns the row.
   */
  private recordStall(
    loop: RalphLoopState,
    target: string,
    reason: string,
    blockers: string[],
    stallConfig: ReturnType<typeof resolveStallConfig>,
    taskId: string,
    events: RalphCyclerEvent[],
  ): BurnedOutTarget {
    if (!loop.burnedOutTargets) loop.burnedOutTargets = [];
    let row = loop.burnedOutTargets.find((t) => t.target === target);
    if (!row) {
      row = {
        target,
        consecutiveStallCount: 0,
        totalStallCount: 0,
        firstStalledAtIteration: loop.currentIteration,
        lastStallReason: reason,
        lastStallBlockers: blockers,
        burned: false,
        lastAttemptedIteration: loop.currentIteration,
      };
      loop.burnedOutTargets.push(row);
    }
    row.consecutiveStallCount += 1;
    row.totalStallCount += 1;
    row.lastStallReason = reason;
    row.lastStallBlockers = blockers;
    row.lastAttemptedIteration = loop.currentIteration;

    const justBurned = !row.burned && row.consecutiveStallCount >= stallConfig.consecutiveStallsPerTarget;
    if (justBurned) {
      row.burned = true;
      events.push({
        type: 'ralph_target_burned',
        taskId,
        target,
        iteration: loop.currentIteration,
        stallCount: row.consecutiveStallCount,
        reason,
      });
    }
    return row;
  }

  /**
   * Reset a target's stallCount to 0 and remove the burn flag. Idempotent —
   * a no-op if the target was never burned. Emits `ralph_target_unburned` only
   * when the target was actually burned and is now being un-burned.
   */
  private unburnTarget(
    loop: RalphLoopState,
    target: string,
    via: 'progress_verdict' | 'patch_burned_targets' | 'decay',
    taskId: string,
    events: RalphCyclerEvent[],
  ): void {
    if (!loop.burnedOutTargets) return;
    const idx = loop.burnedOutTargets.findIndex((t) => t.target === target);
    if (idx < 0) return;
    const row = loop.burnedOutTargets[idx];
    const wasBurned = row.burned;
    // Reset the burn counter and drop the burned flag, but KEEP the row so
    // `totalStallCount` and `firstStalledAtIteration` survive across burn
    // cycles. The dashboard "burned-out targets" rendering filters by
    // `burned: true` (see RalphLoopPanel.tsx); rendering doesn't depend on
    // the row being absent. Preserves cumulative attempt history through
    // un-burn → re-stall cycles for forensic / dashboard use.
    row.consecutiveStallCount = 0;
    row.burned = false;
    if (wasBurned) {
      events.push({
        type: 'ralph_target_unburned',
        taskId,
        target,
        iteration: loop.currentIteration,
        via,
      });
    }
  }

  private applyDecay(
    loop: RalphLoopState,
    stallConfig: ReturnType<typeof resolveStallConfig>,
    taskId: string,
    events: RalphCyclerEvent[],
  ): void {
    const decay = (stallConfig as { burnedTargetDecayIterations?: number }).burnedTargetDecayIterations;
    if (decay === undefined || !loop.burnedOutTargets) return;
    const stale = loop.burnedOutTargets.filter(
      (t) => loop.currentIteration - t.lastAttemptedIteration >= decay,
    );
    for (const row of stale) {
      this.unburnTarget(loop, row.target, 'decay', taskId, events);
    }
  }

  private allDeclaredBurned(loop: RalphLoopState, declared: string[]): boolean {
    const burnedSet = new Set(
      (loop.burnedOutTargets ?? []).filter((t) => t.burned).map((t) => t.target),
    );
    return declared.every((d) => burnedSet.has(canonicalizeTarget(d)));
  }

  private async finishIteration(
    task: Task,
    loop: RalphLoopState,
    fields: Pick<
      RalphIterationRecord,
      'startedAt' | 'endedAt' | 'exitReason' | 'cumulativeCostUsd' | 'costDeltaUsd' | 'verdict'
    >,
  ): Promise<void> {
    const diff = await this.computeIterationDiff(task, loop);
    loop.zeroDiffStreak = nextZeroDiffStreakFor(loop, diff.diffStats);
    await this.appendFinishedIteration(task, loop, {
      ...fields,
      gitBaselineRef: diff.gitBaselineRef,
      diffStats: diff.diffStats,
    });
  }

  private async computeIterationDiff(
    task: Task,
    loop: RalphLoopState,
  ): Promise<Pick<RalphIterationRecord, 'gitBaselineRef' | 'diffStats'>> {
    const baselineRef = `ralph/iter-${loop.currentIteration}-start`;
    const diffStats = await this.io.computeDiffStats(baselineRef, { cwd: task.cwd });
    const refForRecord = diffStats === null ? null : baselineRef;
    return { gitBaselineRef: refForRecord, diffStats };
  }

  private async appendFinishedIteration(
    task: Task,
    loop: RalphLoopState,
    fields: Pick<
      RalphIterationRecord,
      'startedAt' | 'endedAt' | 'exitReason' | 'cumulativeCostUsd' | 'gitBaselineRef' | 'diffStats' | 'costDeltaUsd' | 'verdict'
    >,
  ): Promise<void> {
    const record: RalphIterationRecord = {
      iterationNumber: loop.currentIteration,
      startedAt: fields.startedAt,
      endedAt: fields.endedAt,
      exitReason: fields.exitReason,
      cumulativeCostUsd: fields.cumulativeCostUsd,
      gitBaselineRef: fields.gitBaselineRef,
      diffStats: fields.diffStats,
      ...(fields.verdict !== undefined ? { verdict: fields.verdict } : {}),
      ...(fields.costDeltaUsd !== undefined ? { costDeltaUsd: fields.costDeltaUsd } : {}),
    };
    try {
      await this.io.appendIterationRecord(task.cwd, record);
    } catch (err) {
      console.warn(`[ralph-cycler] iteration log append failed for task ${task.id}:`, err);
    }
    // Persist the cumulative cost so the NEXT iteration's delta is computable.
    // Only update when known — preserves the "unknown" sentinel through gaps
    // in the cost source (e.g., a transient cost-tracker outage on iteration
    // N still lets iteration N+1 compute a delta against iteration N-1 once
    // the source recovers).
    if (fields.cumulativeCostUsd !== null) {
      loop.lastCumulativeCostUsd = fields.cumulativeCostUsd;
    }
  }

  private terminate(loop: RalphLoopState, status: 'completed' | 'failed' | 'cancelled'): void {
    loop.status = status;
  }
}

function isZeroDiff(stats: RalphIterationDiffStats | null): boolean {
  return stats !== null
    && stats.filesChanged === 0
    && stats.insertions === 0
    && stats.deletions === 0;
}

function nextZeroDiffStreakFor(loop: RalphLoopState, diffStats: RalphIterationDiffStats | null): number {
  return isZeroDiff(diffStats) ? (loop.zeroDiffStreak ?? 0) + 1 : 0;
}

function isZeroDiffConverged(loop: RalphLoopState, nextZeroDiffStreak: number): boolean {
  const threshold = loop.zeroDiffConvergence?.consecutiveIterations;
  return threshold !== undefined && nextZeroDiffStreak >= threshold;
}

function isCostCapReached(loop: RalphLoopState, cumulativeCostUsd: number | null): boolean {
  return loop.costCapUsd !== undefined
    && cumulativeCostUsd !== null
    && cumulativeCostUsd >= loop.costCapUsd;
}

function computeCostDelta(
  current: number | null,
  prior: number | undefined,
): number | null {
  if (current === null || prior === undefined) return null;
  return current - prior;
}
