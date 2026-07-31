/**
 * Injectable TERM -> grace -> KILL escalation for a flat list of pids (no
 * process-tree walk — used to reap single-process leaks, e.g. stale `dtach -a`
 * attach clients, where `process-tree.ts#killProcessTree`'s `/proc` descendant
 * walk would be overkill and its use of the real `process.kill`/`setTimeout`
 * directly makes it awkward to unit-test the escalation ORDER with fakes).
 *
 * Kept deliberately separate from `killProcessTree`: that helper snapshots and
 * kills a whole descendant tree rooted at one pid (dtach master + agent), while
 * this one signals an explicit, already-known flat pid list and takes its
 * liveness/signal/sleep primitives as injected dependencies so tests can
 * assert TERM-before-KILL ordering without spawning or killing any real
 * process (issue #1720 acceptance criteria).
 */

/** Default grace period between the SIGTERM sweep and the SIGKILL sweep. */
export const DEFAULT_ESCALATION_GRACE_MS = 5_000;

export interface ProcessSignaler {
  isAlive(pid: number): boolean;
  signal(pid: number, sig: NodeJS.Signals): void;
}

export interface EscalateKillOptions {
  /** Time to wait after SIGTERM before escalating to SIGKILL. Default 5s. */
  graceMs?: number;
  signaler: ProcessSignaler;
  /** Injectable so tests can run this instantly. Defaults to a real setTimeout-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SIGTERM every pid, wait up to `graceMs` for all of them to exit, then
 * SIGKILL any survivors. Order is: signal ALL pids with TERM first (never
 * interleaved with a survivor's KILL), then, after the single grace wait,
 * signal remaining survivors with KILL. Pids that are already gone are
 * silently skipped (the injected `signaler.signal` is expected to swallow
 * ESRCH-equivalent failures, matching `process-tree.ts#signal`).
 */
export async function escalateKill(pids: number[], options: EscalateKillOptions): Promise<void> {
  const graceMs = options.graceMs ?? DEFAULT_ESCALATION_GRACE_MS;
  const sleep = options.sleep ?? realSleep;
  if (pids.length === 0) return;

  for (const pid of pids) options.signaler.signal(pid, 'SIGTERM');

  if (pids.every((pid) => !options.signaler.isAlive(pid))) return;
  await sleep(graceMs);

  for (const pid of pids) {
    if (options.signaler.isAlive(pid)) options.signaler.signal(pid, 'SIGKILL');
  }
}

/** Real (non-test) process signaler backed by `process.kill`. */
export const realProcessSignaler: ProcessSignaler = {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  signal(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone, or not ours — nothing to do.
    }
  },
};
