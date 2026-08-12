/**
 * Bounded host-stale dtach reaper (issue #2356).
 *
 * When host-wide `staleProcesses.dtach.count` meets the soft pressure bound
 * (default 20), this sweep reclaims process-table kookr-dtach masters that
 * the pure selection policy marks as safe: not live-attached, socket gone,
 * aged past the teardown-race floor. Distinct from the session reaper (#1720),
 * which only acts on backend-reported live sessions.
 *
 * Safety:
 *  - Selection is pure + fail-closed (`planHostStaleDtachReap`).
 *  - Pressure gate: no kills when count &lt; soft bound.
 *  - Rate limit: max N reaps per sweep (default 5).
 *  - Dry-run mode logs would-reap pids without signalling.
 *  - Kill path uses `killProcessTree` (TERM → grace → KILL) only on selected
 *    pids; never unbounded `kill -9` of unknown processes.
 *  - Health counters are last-sweep in-memory only (#1553).
 */
import { existsSync } from 'node:fs';

import { killProcessTree } from '../adapters/process-tree.js';
import { listProcessSnapshots } from '../adapters/proc-process-lister.js';
import { classifyProcess, type ProcessSnapshot } from '../core/orphan-process-scanner.js';
import {
  DEFAULT_DTACH_ORPHAN_MIN_AGE_MS,
  DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
  DEFAULT_HOST_STALE_DTACH_MAX_REAPS_PER_SWEEP,
  buildDtachOrphanCandidatesFromProcesses,
  planHostStaleDtachReap,
  type DtachOrphanCandidate,
  type HostStaleDtachReapPlan,
} from '../core/dtach-orphan-policy.js';

/** Default sweep interval (minutes). On by default so pressure clears without an operator. */
export const DEFAULT_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES = 5;

/** Grace after SIGTERM before SIGKILL for a selected master tree. Shorter than session kill. */
export const DEFAULT_HOST_STALE_DTACH_KILL_GRACE_MS = 2_000;

export interface HostStaleDtachReaperConfig {
  /** Master enable. Default true when env unset. */
  enabled: boolean;
  /** Log-only mode — never signal. Default false. */
  dryRun: boolean;
  /** Soft pressure bound (default 20). `<= 0` disables the pressure gate. */
  softBound: number;
  /** Max pids reaped per sweep (default 5). */
  maxReapsPerSweep: number;
  /** Min age for missing-socket masters (default 60s). */
  minAgeMs: number;
  /** Kill-tree grace ms (default 2s). */
  killGraceMs: number;
}

export interface HostStaleDtachReaperDeps {
  /** Live session ids from the terminal backend (never kill these). */
  listLiveSessionIds: () => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** Injectable process snapshot (default: real `/proc`). */
  listProcesses?: () => ProcessSnapshot[];
  /** Socket existence probe (default: `existsSync`). */
  socketExists?: (path: string) => boolean;
  /** Kill path (default: `killProcessTree`). */
  reap?: (pid: number, graceMs: number) => Promise<void>;
  /** Live config getter so env toggles apply without restart. */
  getConfig: () => HostStaleDtachReaperConfig;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Optional host-wide dtach count override (tests / shared cache). */
  getDtachCount?: (processes: readonly ProcessSnapshot[]) => number;
}

export interface ReapedHostStaleDtach {
  pid: number;
  sessionId: string | null;
  ageMs: number | null;
  reason: string;
}

export interface HostStaleDtachReapSweepResult {
  plan: HostStaleDtachReapPlan;
  dryRun: boolean;
  reaped: ReapedHostStaleDtach[];
  /** Pids selected but kill failed (not counted as reaped). */
  failedPids: number[];
}

export interface HostStaleDtachReaperHealthSnapshot {
  enabled: boolean;
  dryRun: boolean;
  softBound: number;
  maxReapsPerSweep: number;
  lastSweepAt: string | null;
  lastDtachCount: number | null;
  lastUnderPressure: boolean;
  /** Masters reaped (or would-reap in dry-run) on the last sweep. */
  lastHostStaleDtachReaped: number;
  /** Cumulative successful kills (dry-run does not increment). */
  totalHostStaleDtachReaped: number;
  /** Last-sweep skip counters (issue #2356 acceptance names). */
  skippedLiveAttached: number;
  skippedUnderBound: number;
  skippedRateLimited: number;
  skippedSocketPresent: number;
  lastEligibleCount: number;
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'unknown';
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** Masters only — same classifier as `staleProcesses.dtach` (issue #2383). */
function defaultDtachCount(processes: readonly ProcessSnapshot[]): number {
  let n = 0;
  for (const p of processes) {
    if (classifyProcess(p.cmdline) === 'dtach') n += 1;
  }
  return n;
}

/**
 * Resolve reaper config from the environment.
 *
 * | Env | Default | Role |
 * | --- | --- | --- |
 * | `KOOKR_HOST_STALE_DTACH_REAP` | on | `0`/`false`/`off` disables |
 * | `KOOKR_HOST_STALE_DTACH_REAP_DRY_RUN` | off | `1`/`true` log-only |
 * | `KOOKR_HOST_STALE_DTACH_REAP_SOFT_BOUND` | 20 | pressure gate |
 * | `KOOKR_HOST_STALE_DTACH_REAP_MAX_PER_SWEEP` | 5 | rate limit |
 * | `KOOKR_HOST_STALE_DTACH_REAP_MIN_AGE_MS` | 60000 | teardown floor |
 */
export function readHostStaleDtachReaperConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HostStaleDtachReaperConfig {
  const enabledRaw = env.KOOKR_HOST_STALE_DTACH_REAP?.trim().toLowerCase();
  const enabled =
    enabledRaw === undefined || enabledRaw === ''
      ? true
      : !['0', 'false', 'no', 'off'].includes(enabledRaw);

  const dryRaw = env.KOOKR_HOST_STALE_DTACH_REAP_DRY_RUN?.trim().toLowerCase();
  const dryRun = dryRaw === '1' || dryRaw === 'true' || dryRaw === 'yes' || dryRaw === 'on';

  const softBound = parseNonNegInt(
    env.KOOKR_HOST_STALE_DTACH_REAP_SOFT_BOUND,
    DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
  );
  const maxReapsPerSweep = parseNonNegInt(
    env.KOOKR_HOST_STALE_DTACH_REAP_MAX_PER_SWEEP,
    DEFAULT_HOST_STALE_DTACH_MAX_REAPS_PER_SWEEP,
  );
  const minAgeMs = parseNonNegInt(
    env.KOOKR_HOST_STALE_DTACH_REAP_MIN_AGE_MS,
    DEFAULT_DTACH_ORPHAN_MIN_AGE_MS,
  );

  return {
    enabled,
    dryRun,
    softBound,
    maxReapsPerSweep,
    minAgeMs,
    killGraceMs: DEFAULT_HOST_STALE_DTACH_KILL_GRACE_MS,
  };
}

function parseNonNegInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Resolve sweep interval (minutes). Default 5; explicit `0` disables the timer.
 */
export function resolveHostStaleDtachReapIntervalMinutes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.KOOKR_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES?.trim();
  if (!raw) return DEFAULT_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES;
  return value;
}

/**
 * Holds health counters and runs one bounded host-stale sweep.
 */
export class HostStaleDtachReaperService {
  private lastSweepAt: string | null = null;
  private lastDtachCount: number | null = null;
  private lastUnderPressure = false;
  private lastHostStaleDtachReaped = 0;
  private totalHostStaleDtachReaped = 0;
  private skippedLiveAttached = 0;
  private skippedUnderBound = 0;
  private skippedRateLimited = 0;
  private skippedSocketPresent = 0;
  private lastEligibleCount = 0;
  private lastDryRun = false;

  constructor(private readonly deps: HostStaleDtachReaperDeps) {}

  getHealthSnapshot(): HostStaleDtachReaperHealthSnapshot {
    const cfg = this.deps.getConfig();
    return {
      enabled: cfg.enabled,
      dryRun: this.lastDryRun || cfg.dryRun,
      softBound: cfg.softBound,
      maxReapsPerSweep: cfg.maxReapsPerSweep,
      lastSweepAt: this.lastSweepAt,
      lastDtachCount: this.lastDtachCount,
      lastUnderPressure: this.lastUnderPressure,
      lastHostStaleDtachReaped: this.lastHostStaleDtachReaped,
      totalHostStaleDtachReaped: this.totalHostStaleDtachReaped,
      skippedLiveAttached: this.skippedLiveAttached,
      skippedUnderBound: this.skippedUnderBound,
      skippedRateLimited: this.skippedRateLimited,
      skippedSocketPresent: this.skippedSocketPresent,
      lastEligibleCount: this.lastEligibleCount,
    };
  }

  /**
   * Run one sweep. Never throws: kill failures are logged and the sweep continues.
   */
  async runSweep(): Promise<HostStaleDtachReapSweepResult> {
    const cfg = this.deps.getConfig();
    const logger = this.deps.logger ?? console;
    const now = this.deps.now?.() ?? Date.now();
    this.lastDryRun = cfg.dryRun;

    if (!cfg.enabled) {
      const emptyPlan = planHostStaleDtachReap([], {
        dtachCount: 0,
        softBound: cfg.softBound,
        maxReapsPerSweep: cfg.maxReapsPerSweep,
        minAgeMs: cfg.minAgeMs,
      });
      this.recordPlan(emptyPlan, now, 0);
      return { plan: emptyPlan, dryRun: cfg.dryRun, reaped: [], failedPids: [] };
    }

    const listProcesses = this.deps.listProcesses ?? listProcessSnapshots;
    const socketExists = this.deps.socketExists ?? ((p: string) => existsSync(p));
    const reap =
      this.deps.reap ??
      ((pid: number, graceMs: number) => killProcessTree(pid, { graceMs }));
    const getDtachCount = this.deps.getDtachCount ?? defaultDtachCount;

    const processes = listProcesses();
    const liveSessionIds = await this.deps.listLiveSessionIds();
    const candidates = buildDtachOrphanCandidatesFromProcesses(processes, {
      now,
      liveSessionIds,
      socketExists,
    });
    const dtachCount = getDtachCount(processes);
    const plan = planHostStaleDtachReap(candidates, {
      dtachCount,
      softBound: cfg.softBound,
      maxReapsPerSweep: cfg.maxReapsPerSweep,
      minAgeMs: cfg.minAgeMs,
    });

    this.recordPlan(plan, now, plan.toReap.length);

    if (!plan.underPressure) {
      if (plan.eligibleCount > 0) {
        logger.log(
          `[host-stale-dtach-reaper] under soft bound: dtachCount=${plan.dtachCount} ` +
            `< softBound=${plan.softBound}; eligible=${plan.eligibleCount} skipped (no kill)`,
        );
      }
      return { plan, dryRun: cfg.dryRun, reaped: [], failedPids: [] };
    }

    if (plan.toReap.length === 0) {
      return { plan, dryRun: cfg.dryRun, reaped: [], failedPids: [] };
    }

    const reaped: ReapedHostStaleDtach[] = [];
    const failedPids: number[] = [];

    for (const candidate of plan.toReap) {
      const entry = this.describeCandidate(candidate);
      if (cfg.dryRun) {
        logger.warn(
          `[host-stale-dtach-reaper] dry-run would reap pid=${candidate.pid} ` +
            `session=${candidate.sessionId ?? 'unknown'} age=${formatAge(candidate.ageMs)} ` +
            `(${entry.reason})`,
        );
        reaped.push(entry);
        continue;
      }
      try {
        await reap(candidate.pid, cfg.killGraceMs);
        reaped.push(entry);
        this.totalHostStaleDtachReaped += 1;
        logger.warn(
          `[host-stale-dtach-reaper] reaped pid=${candidate.pid} ` +
            `session=${candidate.sessionId ?? 'unknown'} age=${formatAge(candidate.ageMs)} ` +
            `(${entry.reason})`,
        );
      } catch (err) {
        failedPids.push(candidate.pid);
        logger.error(
          `[host-stale-dtach-reaper] failed to reap pid=${candidate.pid}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // Dry-run counts as "last reaped" for observability of what would run.
    this.lastHostStaleDtachReaped = reaped.length;

    if (reaped.length > 0) {
      logger.log(
        `[host-stale-dtach-reaper] ${cfg.dryRun ? 'dry-run ' : ''}swept ${reaped.length} ` +
          `host-stale dtach master(s) (dtachCount=${plan.dtachCount} softBound=${plan.softBound} ` +
          `eligible=${plan.eligibleCount} rateLimited=${plan.skippedRateLimited})`,
      );
    }

    return { plan, dryRun: cfg.dryRun, reaped, failedPids };
  }

  private describeCandidate(c: DtachOrphanCandidate): ReapedHostStaleDtach {
    return {
      pid: c.pid,
      sessionId: c.sessionId,
      ageMs: c.ageMs,
      reason: 'missing_socket_aged',
    };
  }

  private recordPlan(plan: HostStaleDtachReapPlan, now: number, lastReaped: number): void {
    this.lastSweepAt = new Date(now).toISOString();
    this.lastDtachCount = plan.dtachCount;
    this.lastUnderPressure = plan.underPressure;
    this.lastHostStaleDtachReaped = lastReaped;
    this.skippedLiveAttached = plan.skippedLiveAttached;
    this.skippedUnderBound = plan.skippedUnderBound;
    this.skippedRateLimited = plan.skippedRateLimited;
    this.skippedSocketPresent = plan.skippedSocketPresent;
    this.lastEligibleCount = plan.eligibleCount;
  }
}

/**
 * One-shot schedule helper: catch errors so an interval never crashes the process.
 */
export async function runScheduledHostStaleDtachReap(
  service: Pick<HostStaleDtachReaperService, 'runSweep'>,
  logger: Pick<Console, 'error'> = console,
): Promise<void> {
  try {
    await service.runSweep();
  } catch (err) {
    logger.error(
      '[host-stale-dtach-reaper] scheduled sweep failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
