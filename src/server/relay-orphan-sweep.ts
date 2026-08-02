/**
 * Issue #1723 item 3: janitor sweep for leaked relay-server orphans.
 *
 * The die-with-parent watchdog (relay/die-with-parent.ts) stops NEW leaks, but a
 * sweep is the backstop for anything already stranded — e.g. a relay whose task
 * worktree was deleted after `pnpm test`, leaving a `relay/server.ts` process
 * with a now-nonexistent cwd. Each sweep scans the process table, selects
 * relay orphans that are safe to reap (worktree gone AND aged past a small
 * floor), kills the whole process tree, and logs pid/age/RSS per reap.
 *
 * Deliberately conservative: a live PRODUCTION relay always has an existing cwd
 * and is therefore never selected (see selectRelayOrphansToReap). dtach orphans
 * are surfaced for visibility but reaped by #1720's session reconciler, which
 * owns the task/session map.
 */
import { existsSync } from 'node:fs';

import { killProcessTree } from '../adapters/process-tree.js';
import { listProcessSnapshots, readProcessEnviron } from '../adapters/proc-process-lister.js';
import {
  scanStaleProcesses,
  selectRelayOrphansToReap,
  type RelayReapPolicy,
  type StaleProcess,
} from '../core/orphan-process-scanner.js';

export interface RelayOrphanSweepDeps {
  /** Returns the current classified stale-process scan. Injectable for tests. */
  scan?: () => StaleProcess[];
  /** Kills a process tree (TERM → grace → KILL). Injectable for tests. */
  reap?: (pid: number) => Promise<void>;
  /** Current time in ms. */
  now?: () => number;
  /** Reap policy (min/max age). Defaults to worktree-gone-only. */
  policy?: RelayReapPolicy;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Pids to never reap (e.g. this server's own tree). */
  excludePids?: ReadonlySet<number>;
}

export interface ReapedRelayOrphan {
  pid: number;
  ageMs: number | null;
  rssBytes: number;
  cwd: string | null;
}

export interface RelayOrphanSweepResult {
  scanned: number;
  candidates: number;
  reaped: ReapedRelayOrphan[];
  reapedRssBytes: number;
}

function defaultScan(now: number, excludePids?: ReadonlySet<number>): StaleProcess[] {
  return scanStaleProcesses({
    listProcesses: listProcessSnapshots,
    now,
    cwdExists: (dir) => existsSync(dir),
    // Probe environ so the sweep can reap test-spawned relays whose worktree
    // still exists (issue #1885) — read only for relay-server pids.
    readEnviron: readProcessEnviron,
    ...(excludePids ? { excludePids } : {}),
  });
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'unknown';
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatRss(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Run one relay-orphan sweep. Never throws: a failure to kill a single pid is
 * logged and the sweep continues. Returns what was scanned/selected/reaped.
 */
export async function runRelayOrphanSweep(
  deps: RelayOrphanSweepDeps = {},
): Promise<RelayOrphanSweepResult> {
  const now = deps.now ? deps.now() : Date.now();
  const logger = deps.logger ?? console;
  const reap = deps.reap ?? ((pid: number) => killProcessTree(pid));
  const scan = deps.scan ?? (() => defaultScan(now, deps.excludePids));

  const all = scan();
  const candidates = selectRelayOrphansToReap(all, deps.policy ?? {});
  const reaped: ReapedRelayOrphan[] = [];
  let reapedRssBytes = 0;

  for (const proc of candidates) {
    try {
      await reap(proc.pid);
      reaped.push({ pid: proc.pid, ageMs: proc.ageMs, rssBytes: proc.rssBytes, cwd: proc.cwd });
      reapedRssBytes += proc.rssBytes;
      const reason = proc.testSpawned
        ? 'test-runner marker, #1885'
        : proc.cwdExists
          ? 'age ceiling'
          : 'worktree gone, #1723';
      logger.warn(
        `[relay-orphan-sweep] reaped relay pid=${proc.pid} age=${formatAge(proc.ageMs)} ` +
          `rss=${formatRss(proc.rssBytes)} cwd=${proc.cwd ?? 'unknown'} (${reason})`,
      );
    } catch (err) {
      logger.error(
        `[relay-orphan-sweep] failed to reap relay pid=${proc.pid}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  if (reaped.length > 0) {
    logger.log(
      `[relay-orphan-sweep] swept ${reaped.length} relay orphan(s), ` +
        `freed ~${formatRss(reapedRssBytes)} RSS (scanned ${all.length} stale process(es))`,
    );
  }

  return { scanned: all.length, candidates: candidates.length, reaped, reapedRssBytes };
}

/**
 * Default relay-orphan sweep interval (hours). On by default so a long-lived
 * production daemon actively reaps stranded relays without an operator flipping
 * an env var — the gap that let #1723's fix regress into #1885 (the sweep was
 * the only always-on reaper in production, and it was off by default). Safe:
 * the sweep only ever selects worktree-gone or test-spawn-marked relays, which
 * a live production relay is never either of.
 */
export const DEFAULT_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS = 1;

/**
 * Resolve the relay-orphan sweep interval (hours) from the environment. Returns
 * the default (on) when unset or invalid; an explicit `0` (or negative) DISABLES
 * the timer — mirroring the reflect-worktree sweep (#1860), not the opt-in
 * maintenance-prune sweep. Change from #1723, where this defaulted to off.
 */
export function resolveRelayOrphanSweepIntervalHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS?.trim();
  if (!raw) return DEFAULT_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS;
  return value;
}
