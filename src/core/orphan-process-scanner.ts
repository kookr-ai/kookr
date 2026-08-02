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
  /**
   * Whether this relay was spawned under a test RUNNER — a `KOOKR_RELAY_DIE_WITH_PARENT`
   * or any `VITEST*` env marker (see {@link isTestRunnerSpawnedRelayEnviron}). A
   * PRODUCTION relay carries neither, so it is a production-safe signal that this
   * relay is a stranded test child — reapable even when its worktree still exists
   * (issue #1885). False for `dtach` and whenever the environ was not probed
   * (`readEnviron` unset in the scan deps).
   */
  testSpawned: boolean;
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
 * Whether a process's environment carries the `KOOKR_RELAY_DIE_WITH_PARENT=1`
 * marker set by vitest.config.ts (#1723). Narrow, exact-match check.
 */
export function isTestSpawnedRelayEnviron(env: Record<string, string> | null): boolean {
  if (!env) return false;
  const v = env.KOOKR_RELAY_DIE_WITH_PARENT;
  return v === '1' || v === 'true';
}

/**
 * Whether a process's environment marks it as a relay spawned under a test
 * RUNNER — the broader, production-safe fingerprint the reaper keys on (#1885).
 *
 * Matches EITHER the `KOOKR_RELAY_DIE_WITH_PARENT` marker (post-#1723 relays)
 * OR any `VITEST*` env key. `relay-lifecycle` spawns the relay with
 * `env: { ...process.env }`, so a relay launched by a vitest worker always
 * inherits `VITEST` / `VITEST_WORKER_ID` / `VITEST_POOL_ID`. This is what caught
 * #1885's real leak: 22 stranded relays in the main checkout that carried
 * `VITEST` but NOT the die marker (they predate it), so the die-marker-only scan
 * from #1723 was blind to them while they accumulated. A PRODUCTION relay is
 * never launched under vitest and never carries the die marker, so neither
 * signal can ever select it — the whole production-safety guarantee.
 */
export function isTestRunnerSpawnedRelayEnviron(env: Record<string, string> | null): boolean {
  if (!env) return false;
  if (isTestSpawnedRelayEnviron(env)) return true;
  return Object.keys(env).some((key) => key === 'VITEST' || key.startsWith('VITEST_'));
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
  /**
   * Read a process's environment (`/proc/<pid>/environ`) to detect the
   * test-runner fingerprint (`KOOKR_RELAY_DIE_WITH_PARENT` or any `VITEST*` key;
   * see {@link isTestRunnerSpawnedRelayEnviron}). Only invoked for relay-server
   * processes, so the reaping sweep pays the environ read for a handful of pids,
   * never the whole table. When unset (e.g. the `/api/health` summary path,
   * which only needs counts) every `testSpawned` stays false.
   */
  readEnviron?: (pid: number) => Record<string, string> | null;
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
    // Probe the environ only for relay servers, only when a reader is wired.
    const testSpawned =
      klass === 'relay-server' && deps.readEnviron
        ? isTestRunnerSpawnedRelayEnviron(deps.readEnviron(proc.pid))
        : false;
    out.push({
      pid: proc.pid,
      klass,
      ageMs,
      rssBytes: proc.rssBytes,
      cwd: proc.cwd,
      cwdExists: proc.cwd === null ? false : cwdExists(proc.cwd),
      testSpawned,
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
 * Safe by construction — two production-safe kill signals, both of which a live
 * production relay can never satisfy:
 *  1. A DELETED working directory (a task worktree removed after `pnpm test`);
 *     a prod relay's cwd always exists.
 *  2. The test-runner fingerprint (`p.testSpawned`: `KOOKR_RELAY_DIE_WITH_PARENT`
 *     or any `VITEST*` marker); a prod relay carries neither. This is the fix
 *     for issue #1885's
 *     recurrence: test/e2e relays that outlived their runner while their
 *     worktree is STILL present (reused worktrees, hourly-smoke ticks) — the
 *     class the worktree-gone signal alone never reached, so they accumulated
 *     to 29 orphans / ~1.5 GB after #1723.
 *
 * Both require a minimum age so a relay spawned this instant is not raced. Only
 * when `maxAgeMs` is explicitly set does age alone qualify a process — callers
 * must opt into that and ensure the production relay is excluded.
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
    // Test-spawn marker → a stranded test/e2e relay regardless of cwd (#1885).
    if (p.testSpawned && aged) return true;
    // Age-only reaping is opt-in and never applies to a still-present cwd unless
    // the caller explicitly set a ceiling.
    if (maxAgeMs !== undefined && p.ageMs !== null && p.ageMs >= maxAgeMs) return true;
    return false;
  });
}

/** Default bound: alert once relay-server orphans exceed this count (#1885). */
export const DEFAULT_RELAY_ORPHAN_BOUND = 5;

/** First-class finding code emitted when the relay-orphan bound is exceeded. */
export const RELAY_ORPHAN_FINDING_CODE = 'relay_orphan_accumulation';

/**
 * A first-class health finding: relay-server orphans have grown past the bound
 * (issue #1885 acceptance criterion). Lets sentinel/reflection cite a stable
 * `code` instead of re-deriving a threshold from raw counts every time.
 */
export interface RelayOrphanFinding {
  code: typeof RELAY_ORPHAN_FINDING_CODE;
  /** Current relay-server orphan count. */
  count: number;
  /** The bound that was exceeded. */
  bound: number;
  rssBytes: number;
}

/**
 * Evaluate the relay-orphan bound against a scan summary. Returns a finding when
 * `relayServer.count` strictly exceeds `bound`, else null (so the health block
 * is only present when there is something to act on). Pure.
 */
export function evaluateRelayOrphanBound(
  summary: StaleProcessSummary,
  bound: number = DEFAULT_RELAY_ORPHAN_BOUND,
): RelayOrphanFinding | null {
  if (summary.relayServer.count <= bound) return null;
  return {
    code: RELAY_ORPHAN_FINDING_CODE,
    count: summary.relayServer.count,
    bound,
    rssBytes: summary.relayServer.rssBytes,
  };
}

/**
 * Resolve the relay-orphan alert bound from the environment. Returns the
 * default when unset, non-numeric, or negative — a small non-negative integer.
 */
export function resolveRelayOrphanBound(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KOOKR_RELAY_ORPHAN_ALERT_BOUND?.trim();
  if (!raw) return DEFAULT_RELAY_ORPHAN_BOUND;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RELAY_ORPHAN_BOUND;
  return Math.floor(value);
}
