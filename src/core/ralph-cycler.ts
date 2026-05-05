import type { Task, TaskStore, RalphLoopState } from './tasks.js';
import { runStopPredicate, type PredicateResult } from './ralph-predicate.js';
import { createBaselineTag, computeDiffStats } from './ralph-git-baseline.js';
import {
  appendIterationRecord,
  type RalphIterationExitReason,
  type RalphIterationDiffStats,
  type RalphIterationRecord,
} from './ralph-iteration-log.js';

/**
 * Per-Stop controller for Ralph Wiggum iteration loops (issue #440).
 *
 * Unlike `CheckpointCycler`, this controller is stateless and reads/writes
 * the loop state directly on `task.ralphLoop`. The loop *is* the persisted
 * data — there is no ephemeral side-state to forget on session lifecycle
 * events. This is why it's a peer module rather than a CheckpointCycler
 * config variant: the two have orthogonal state-ownership models.
 *
 * Lifecycle:
 *   1. Caller (event-pipeline.ts) receives a Stop event.
 *   2. Caller invokes `handleStop(taskId, ...)`.
 *   3. We read the loop, decide what to do, persist the iteration record,
 *      mutate `task.ralphLoop`, and return an action for the caller to
 *      dispatch by launching a fresh agent runtime.
 *
 * Decision order (cheapest-first per issue spec):
 *   - manual cancel/pause states (terminal or do-nothing)
 *   - iteration cap reached → terminate
 *   - predicate satisfied   → terminate
 *   - cost cap reached      → terminate (only when cost is known)
 *   - zero-diff convergence → terminate
 *   - else                  → continue (fresh runtime)
 */

/** Action returned to the caller. */
export type RalphCyclerAction =
  /** Launch `task.ralphLoop.prompt` as the first instruction in a fresh runtime. */
  | { kind: 'launch_fresh'; taskId: string; text: string }
  /** Loop has reached a terminal state — caller need not dispatch anything. */
  | { kind: 'terminate'; reason: RalphIterationExitReason }
  /** Nothing to do (no loop, paused, or already terminal). */
  | { kind: 'noop' };

export interface RalphCyclerHandleStopOptions {
  /** Task ID emitting Stop. */
  taskId: string;
  /** Terminal session id that emitted the Stop event. */
  sessionId: string;
  /**
   * Cumulative cost for this iteration, best-effort from the Stop hook event.
   * `null` (not omitted) when the source is unavailable so readers can tell
   * "free" from "unknown" — see issue #440 §"Cost source".
   */
  cumulativeCostUsd?: number | null;
  /**
   * Optional path to the just-finished agent turn's output, exposed to the
   * predicate as `$RALPH_LAST_OUTPUT_FILE`. Undefined when no such file is
   * available.
   */
  lastOutputFile?: string;
  /** Override clock for tests. */
  now?: number;
}

/**
 * Pluggable I/O surface so the cycler can be unit-tested without spawning
 * shells, hitting git, or writing to disk. Production wiring uses real
 * implementations; tests inject fakes.
 */
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
    const task = taskStore.getTask(opts.taskId);
    if (!task) return { kind: 'noop' };
    const loop = task.ralphLoop;
    if (!loop) return { kind: 'noop' };

    // Terminal states: nothing to do. Pause is also non-acting (loop stays
    // alive but does not launch the next runtime); resume must be explicit.
    if (loop.status !== 'running') return { kind: 'noop' };

    const now = opts.now ?? Date.now();
    const startedAt = loop.lastIterationStartedAt > 0
      ? loop.lastIterationStartedAt
      : now;

    // FAST CHECK: iteration cap. Always-checked, separate from the predicate
    // so a 5s predicate timeout never delays a hard-stop.
    if (loop.currentIteration >= loop.iterationCap) {
      await this.finishIteration(task, loop, {
        startedAt,
        endedAt: now,
        exitReason: 'iteration_cap',
        cumulativeCostUsd: opts.cumulativeCostUsd ?? null,
      });
      this.terminate(loop, 'completed');
      return { kind: 'terminate', reason: 'iteration_cap' };
    }

    // SLOW CHECK: optional shell predicate. Failures (timeout, error) keep
    // the loop alive — only a clean `exit 0` terminates.
    let predicateOutcome: PredicateResult | null = null;
    if (loop.stopPredicate) {
      predicateOutcome = await this.io.runPredicate(loop.stopPredicate, {
        cwd: task.cwd,
        iteration: loop.currentIteration,
        lastOutputFile: opts.lastOutputFile,
      });
      if (predicateOutcome.satisfied) {
        await this.finishIteration(task, loop, {
          startedAt,
          endedAt: now,
          exitReason: 'predicate_satisfied',
          cumulativeCostUsd: opts.cumulativeCostUsd ?? null,
        });
        this.terminate(loop, 'completed');
        return { kind: 'terminate', reason: 'predicate_satisfied' };
      }
    }

    const diff = await this.computeIterationDiff(task, loop);
    const nextZeroDiffStreak = nextZeroDiffStreakFor(loop, diff.diffStats);
    const cost = opts.cumulativeCostUsd ?? null;

    if (isCostCapReached(loop, cost)) {
      loop.zeroDiffStreak = nextZeroDiffStreak;
      await this.appendFinishedIteration(task, loop, {
        startedAt,
        endedAt: now,
        exitReason: 'cost_cap',
        cumulativeCostUsd: cost,
        gitBaselineRef: diff.gitBaselineRef,
        diffStats: diff.diffStats,
      });
      this.terminate(loop, 'completed');
      task.updatedAt = new Date(now);
      return { kind: 'terminate', reason: 'cost_cap' };
    }

    if (isZeroDiffConverged(loop, nextZeroDiffStreak)) {
      loop.zeroDiffStreak = nextZeroDiffStreak;
      await this.appendFinishedIteration(task, loop, {
        startedAt,
        endedAt: now,
        exitReason: 'zero_diff_convergence',
        cumulativeCostUsd: cost,
        gitBaselineRef: diff.gitBaselineRef,
        diffStats: diff.diffStats,
      });
      this.terminate(loop, 'completed');
      task.updatedAt = new Date(now);
      return { kind: 'terminate', reason: 'zero_diff_convergence' };
    }

    // CONTINUE: persist the just-finished iteration, advance the counter,
    // tag a new baseline, return the fresh-runtime launch action.
    const exitReason: RalphIterationExitReason = predicateOutcome?.timedOut
      ? 'predicate_timeout'
      : predicateOutcome?.errored
      ? 'predicate_error'
      : 'continued';

    loop.zeroDiffStreak = nextZeroDiffStreak;
    await this.appendFinishedIteration(task, loop, {
      startedAt,
      endedAt: now,
      exitReason,
      cumulativeCostUsd: cost,
      gitBaselineRef: diff.gitBaselineRef,
      diffStats: diff.diffStats,
    });

    const nextIteration = loop.currentIteration + 1;
    loop.currentIteration = nextIteration;
    loop.cumulativeIterations += 1;
    loop.lastIterationStartedAt = now;
    task.updatedAt = new Date(now);

    // Best-effort baseline tag for the iteration we are about to start. The
    // tag's success/failure is observed by the *next* iteration's diff stats,
    // not this one — we don't await the diff here.
    void this.io.createBaselineTag(nextIteration, { cwd: task.cwd });

    return { kind: 'launch_fresh', taskId: task.id, text: loop.prompt };
  }

  /**
   * Write the iteration record to the JSONL log + compute its diff stats.
   * Failures here never throw — the audit trail is best-effort and must
   * never break the live loop.
   */
  private async finishIteration(
    task: Task,
    loop: RalphLoopState,
    fields: Pick<RalphIterationRecord, 'startedAt' | 'endedAt' | 'exitReason' | 'cumulativeCostUsd'>,
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
    // If the baseline tag never existed (the diff returned null on the first
    // iteration before any tag was created), persist null for the ref too.
    const refForRecord = diffStats === null ? null : baselineRef;
    return { gitBaselineRef: refForRecord, diffStats };
  }

  private async appendFinishedIteration(
    task: Task,
    loop: RalphLoopState,
    fields: Pick<RalphIterationRecord, 'startedAt' | 'endedAt' | 'exitReason' | 'cumulativeCostUsd' | 'gitBaselineRef' | 'diffStats'>,
  ): Promise<void> {
    const record: RalphIterationRecord = {
      iterationNumber: loop.currentIteration,
      startedAt: fields.startedAt,
      endedAt: fields.endedAt,
      exitReason: fields.exitReason,
      cumulativeCostUsd: fields.cumulativeCostUsd,
      gitBaselineRef: fields.gitBaselineRef,
      diffStats: fields.diffStats,
    };
    try {
      await this.io.appendIterationRecord(task.cwd, record);
    } catch (err) {
      console.warn(`[ralph-cycler] iteration log append failed for task ${task.id}:`, err);
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
  // Cost telemetry is best-effort. Unknown cost fails closed: do not stop
  // solely on cost unless the Stop event provided a concrete cumulative value.
  return loop.costCapUsd !== undefined
    && cumulativeCostUsd !== null
    && cumulativeCostUsd >= loop.costCapUsd;
}
