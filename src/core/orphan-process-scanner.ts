/**
 * Issue #1723 / #1720: stale-process observability + reap classification.
 *
 * Two classes of process leak until something reaps them:
 *  - `relay-server`: `relay/server.(ts|js)` processes spawned by the relay test
 *    harness (and the production relay lifecycle) that survive their launcher.
 *  - `dtach`: orphaned `dtach` masters under `/tmp/kookr-dtach/...` whose agent
 *    session is no longer tracked (#1720).
 *
 * This module is pure: it classifies and filters an injected snapshot of running
 * processes. The real `/proc` reader lives in
 * `src/adapters/proc-process-lister.ts` so this logic stays unit-testable
 * without touching the host process table.
 */

/** A stale-process class we track for visibility and (relay-only) reaping. */
export type StaleProcessClass = 'relay-server' | 'dtach';

/** A raw snapshot of one running process, as read from `/proc` (or a test). */
export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  /** Full command line (argv joined with spaces). */
  cmdline: string;
  /** Resident set size in bytes, or 0 when unknown. */
  rssBytes: number;
  /** Wall-clock start time (ms since epoch), or null when unknown. */
  startTimeMs: number | null;
  /** Resolved working directory (`/proc/<pid>/cwd`), or null when unreadable. */
  cwd: string | null;
}

/** A classified stale process with derived age/liveness fields. */
export interface StaleProcess {
  pid: number;
  klass: StaleProcessClass;
  /** Age in ms (now - startTime), or null when the start time is unknown. */
  ageMs: number | null;
  rssBytes: number;
  cwd: string | null;
  /** Whether the process's working directory still exists on disk. */
  cwdExists: boolean;
}

/** Aggregate counts + RSS per class, for `/api/health` diagnostics. */
export interface StaleProcessSummary {
  relayServer: { count: number; rssBytes: number };
  dtach: { count: number; rssBytes: number };
}

/**
 * Classify a process by its command line, or return null when it is neither a
 * relay server nor a kookr dtach master. Conservative substring matching so a
 * grep for `relay/server` in an unrelated editor/argv does not misclassify — we
 * require the canonical `relay/server.ts|js` path segment.
 */
export function classifyProcess(cmdline: string): StaleProcessClass | null {
  if (!cmdline) return null;
  if (
    cmdline.includes('relay/server.ts') ||
    cmdline.includes('relay/server.js') ||
    cmdline.includes('/relay/server')
  ) {
    return 'relay-server';
  }
  // dtach masters carry the kookr socket ring path in argv (#1720). Require the
  // kookr-specific segment so unrelated dtach usage is never swept.
  if (cmdline.includes('dtach') && cmdline.includes('kookr-dtach')) {
    return 'dtach';
  }
  return null;
}

/**
 * Whether a process's environment marks it as a relay spawned BY the test suite
 * (via `KOOKR_RELAY_DIE_WITH_PARENT=1`, set in vitest.config.ts). The post-test
 * reaper uses this to scope its kill strictly to test-suite relays, never a
 * developer's separately-running local/prod relay on the same machine.
 */
export function isTestSpawnedRelayEnviron(env: Record<string, string> | null): boolean {
  if (!env) return false;
  const v = env.KOOKR_RELAY_DIE_WITH_PARENT;
  return v === '1' || v === 'true';
}

export interface ScanStaleProcessesDeps {
  /** Snapshot of running processes (injected; real reader lives in adapters). */
  listProcesses: () => ProcessSnapshot[];
  /** Current time in ms since epoch. */
  now: number;
  /** Existence check for a working directory. Defaults to a real fs check. */
  cwdExists?: (dir: string) => boolean;
  /** Pids to exclude from the result (e.g. the scanner's own process tree). */
  excludePids?: ReadonlySet<number>;
}

/**
 * Scan the injected process snapshot and return every classified stale process.
 * Pure aside from the optional `cwdExists` probe (defaulted by the caller).
 */
export function scanStaleProcesses(deps: ScanStaleProcessesDeps): StaleProcess[] {
  const cwdExists = deps.cwdExists ?? (() => true);
  const exclude = deps.excludePids ?? new Set<number>();
  const out: StaleProcess[] = [];
  for (const proc of deps.listProcesses()) {
    if (exclude.has(proc.pid)) continue;
    const klass = classifyProcess(proc.cmdline);
    if (!klass) continue;
    const ageMs = proc.startTimeMs === null ? null : Math.max(0, deps.now - proc.startTimeMs);
    out.push({
      pid: proc.pid,
      klass,
      ageMs,
      rssBytes: proc.rssBytes,
      cwd: proc.cwd,
      cwdExists: proc.cwd === null ? false : cwdExists(proc.cwd),
    });
  }
  return out;
}

/** Aggregate a scan into per-class count + RSS totals. */
export function summarizeStaleProcesses(procs: readonly StaleProcess[]): StaleProcessSummary {
  const summary: StaleProcessSummary = {
    relayServer: { count: 0, rssBytes: 0 },
    dtach: { count: 0, rssBytes: 0 },
  };
  for (const p of procs) {
    const bucket = p.klass === 'relay-server' ? summary.relayServer : summary.dtach;
    bucket.count += 1;
    bucket.rssBytes += p.rssBytes;
  }
  return summary;
}

export interface RelayReapPolicy {
  /**
   * Minimum age (ms) before a relay orphan whose worktree is gone may be
   * reaped, so a relay spawned into a directory that is being torn down this
   * instant is not raced. Defaults to 60s.
   */
  minAgeMs?: number;
  /**
   * Optional hard age ceiling (ms). A relay server older than this is reaped
   * even if its worktree still exists. Undefined (default) disables age-only
   * reaping — the safe posture, since a long-lived PRODUCTION relay's cwd
   * always exists and must never be swept.
   */
  maxAgeMs?: number;
}

/**
 * Select which relay-server orphans a janitor sweep should reap.
 *
 * Safe by construction: the primary signal is a DELETED working directory (a
 * task worktree removed after `pnpm test`), which a live production relay never
 * has. Only when `maxAgeMs` is explicitly set does age alone qualify a process
 * — callers must opt into that and ensure the production relay is excluded.
 *
 * `dtach` orphans are surfaced for visibility but NOT selected here; their
 * reaping is owned by #1720's session reconciler, which has the task/session
 * map needed to decide safely.
 */
export function selectRelayOrphansToReap(
  procs: readonly StaleProcess[],
  policy: RelayReapPolicy = {},
): StaleProcess[] {
  const minAgeMs = policy.minAgeMs ?? 60_000;
  const maxAgeMs = policy.maxAgeMs;
  return procs.filter((p) => {
    if (p.klass !== 'relay-server') return false;
    const aged = p.ageMs === null ? false : p.ageMs >= minAgeMs;
    // Worktree gone → orphaned; require a minimum age to avoid a teardown race.
    if (!p.cwdExists && aged) return true;
    // Age-only reaping is opt-in and never applies to a still-present cwd unless
    // the caller explicitly set a ceiling.
    if (maxAgeMs !== undefined && p.ageMs !== null && p.ageMs >= maxAgeMs) return true;
    return false;
  });
}
