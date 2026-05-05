import { spawn } from 'node:child_process';

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
 * Timeouts are enforced by SIGTERM after `timeoutMs`, then SIGKILL after a
 * 200 ms grace if the child is still alive. The default 5 s budget matches the
 * issue's stated mitigation for "predicate execution time bloat".
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
    let child;
    try {
      child = spawnImpl('/bin/sh', ['-c', command], {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      resolve({
        satisfied: false,
        exitCode: null,
        timedOut: false,
        errored: true,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let timedOut = false;
    let killGraceTimer: NodeJS.Timeout | null = null;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killGraceTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolve({
        satisfied: false,
        exitCode: null,
        timedOut,
        errored: true,
        errorMessage: err.message,
      });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      // A signal-killed exit (timeout path) is NOT satisfied even if code is 0
      // because some shells coerce SIGTERM into a 0 exit on certain builtins.
      const exitCode = code;
      const wasSignaled = signal !== null;
      const satisfied = !timedOut && !wasSignaled && exitCode === 0;
      resolve({
        satisfied,
        exitCode,
        timedOut,
        errored: false,
      });
    });
  });
}
