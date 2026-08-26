import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Execute a user-supplied shell predicate to decide whether a Ralph iteration
 * loop should continue. The predicate is the loop's stop primitive (issue #440):
 *
 *   exit 0  → stop (predicate satisfied, terminate the loop)
 *   exit !0 → continue
 *   timeout → continue (treated like a non-zero exit so the loop stays live)
 *   error   → continue (spawn / exec failure; controller may degrade behavior)
 *
 * The predicate runs in a real shell so users can write idiomatic checks like
 * `grep -q DONE prompt.md && [ -f .ralph-stop ]`. Shell injection is *intentional*
 * here — the user-supplied string IS the program. The controller never composes
 * this string with untrusted input.
 *
 * Timeout cleanup (issue #2857): the predicate is spawned `detached`, so on
 * Linux and macOS it leads its own process group (pgid == child.pid). On
 * timeout we escalate against the whole *group* — SIGTERM the group after
 * `timeoutMs`, then SIGKILL any survivors after a 200 ms grace — instead of the
 * single child. This reaps a TERM-ignoring predicate and its same-group
 * descendants that the old `child.kill()` + `child.killed` gate leaked:
 * `child.killed` flips true when the signal is *sent*, not when the process
 * dies, so a predicate that ignores SIGTERM never received the follow-up
 * SIGKILL. The whole timeout path settles exactly once and, before it settles,
 * confirms the group is actually gone rather than trusting that SIGKILL was
 * delivered synchronously. The default 5 s budget matches the issue's stated
 * mitigation for "predicate execution time bloat".
 *
 * Known limitation: a descendant that deliberately starts a *new* session
 * (`setsid`) leaves the predicate's process group and is therefore outside the
 * scope of this cleanup — the same boundary every process-group reaper has.
 */

export interface PredicateOptions {
  cwd: string;
  /** Iteration counter exposed to the predicate as $RALPH_ITERATION. */
  iteration: number;
  /**
   * Path to the latest captured agent output, exposed as
   * $RALPH_LAST_OUTPUT_FILE. Optional — undefined when no transcript snapshot
   * is available; the env var is then unset.
   */
  lastOutputFile?: string;
  /** Hard timeout for the predicate process. Default 5000 ms per issue spec. */
  timeoutMs?: number;
  /** Allow tests to inject extra env entries. Real callers pass nothing. */
  extraEnv?: Record<string, string>;
  /** Exec backend. Tests inject a fake. Defaults to node:child_process spawn. */
  spawn?: typeof spawn;
}

export interface PredicateResult {
  /**
   * True iff the predicate exited with code 0 within the timeout. Only this
   * value should drive the controller's terminate decision; treat everything
   * else as "keep looping".
   */
  satisfied: boolean;
  /** Process exit code, or null if the process was killed by signal / never started. */
  exitCode: number | null;
  /** True if the controller killed the process for exceeding `timeoutMs`. */
  timedOut: boolean;
  /** True if spawn itself failed (e.g. shell missing). Distinct from non-zero exit. */
  errored: boolean;
  /** Free-form error message for logging when `errored` is true. */
  errorMessage?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const SIGKILL_GRACE_MS = 200;
/** Poll cadence while confirming the killed group has actually drained. */
const GROUP_DRAIN_POLL_MS = 20;
/**
 * Cap on drain-confirmation polls (~1 s total). A process stuck in
 * uninterruptible sleep can survive even SIGKILL; we must never wedge the
 * predicate promise waiting for it, so after this many polls we settle anyway.
 */
const GROUP_DRAIN_MAX_POLLS = 50;

export async function runStopPredicate(
  command: string,
  opts: PredicateOptions,
): Promise<PredicateResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnImpl = opts.spawn ?? spawn;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.extraEnv,
    RALPH_ITERATION: String(opts.iteration),
  };
  if (opts.lastOutputFile) {
    env.RALPH_LAST_OUTPUT_FILE = opts.lastOutputFile;
  }

  return new Promise<PredicateResult>((resolve) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let timedOut = false;
    let rootExitCode: number | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let drainPolls = 0;

    const clearTimers = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    // Single settlement path: resolve at most once and never leave a timer live.
    const settle = (result: PredicateResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    // Signal the predicate's process group. We MUST guard on a valid positive
    // pid before negating it: `process.kill(-pid, ...)` with pid <= 1 (unset,
    // or a spawn that never produced a pid) would target init or a bogus group.
    const signalGroup = (sig: NodeJS.Signals): void => {
      const pid = child?.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return;
      try {
        process.kill(-pid, sig);
      } catch {
        // ESRCH (group already gone) and friends are the success case here —
        // there is nothing left to kill.
      }
    };

    // True while any member of the predicate's process group is still alive.
    const groupAlive = (): boolean => {
      const pid = child?.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
      try {
        process.kill(-pid, 0);
        return true;
      } catch (err) {
        // ESRCH → the whole group is gone. Anything else (EPERM) → a member
        // exists but we can't signal it; treat as alive so we don't claim a
        // clean sweep we didn't achieve.
        return (err as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    };

    const timeoutResult = (): PredicateResult => ({
      satisfied: false,
      exitCode: rootExitCode,
      timedOut: true,
      errored: false,
    });

    // Resolve the timeout path only once the group has actually drained, so the
    // acceptance guarantee ("descendants absent when the call settles") holds
    // instead of resting on SIGKILL being delivered synchronously. Bounded so an
    // unkillable process can never wedge the promise.
    const settleWhenGroupDrained = () => {
      if (settled) return;
      if (!groupAlive() || drainPolls >= GROUP_DRAIN_MAX_POLLS) {
        settle(timeoutResult());
        return;
      }
      drainPolls += 1;
      graceTimer = setTimeout(settleWhenGroupDrained, GROUP_DRAIN_POLL_MS);
    };

    try {
      child = spawnImpl('/bin/sh', ['-c', command], {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        // Own process group so timeout cleanup can reap the predicate together
        // with everything it forks (issue #2857).
        detached: true,
      });
    } catch (err) {
      settle({
        satisfied: false,
        exitCode: null,
        timedOut: false,
        errored: true,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    killTimer = setTimeout(() => {
      killTimer = null;
      timedOut = true;
      signalGroup('SIGTERM');
      graceTimer = setTimeout(() => {
        graceTimer = null;
        signalGroup('SIGKILL');
        settleWhenGroupDrained();
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.on('error', (err) => {
      // Async spawn failure (e.g. shell missing): there is usually no pid, so
      // the group signals above are no-ops. Report the error and settle.
      settle({
        satisfied: false,
        exitCode: null,
        timedOut,
        errored: true,
        errorMessage: err.message,
      });
    });

    child.on('exit', (code, signal) => {
      rootExitCode = code;

      if (!timedOut) {
        // A signal-killed exit is NOT satisfied even if code is 0, because some
        // shells coerce SIGTERM into a 0 exit on certain builtins.
        const wasSignaled = signal !== null;
        const satisfied = !wasSignaled && code === 0;
        settle({ satisfied, exitCode: code, timedOut: false, errored: false });
        return;
      }

      // Timed out: the group leader has exited (typically from our SIGTERM), but
      // same-group descendants may still be alive. Root exit must NOT cancel
      // descendant cleanup (issue #2857): only settle now if nothing remains;
      // otherwise leave the grace timer running so the SIGKILL sweep still fires.
      if (!groupAlive()) {
        settle(timeoutResult());
      }
    });
  });
}
