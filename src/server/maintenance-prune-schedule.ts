import {
  planAndPruneMaintenance,
  type MaintenancePruneResult,
} from '../core/maintenance-prune.js';
import { runRelayOrphanSweep } from './relay-orphan-sweep.js';

/** Config for the scheduled relay-orphan sweep (issue #1723). */
export interface RelayOrphanSweepScheduleConfig {
  /** Interval between sweeps, in hours. `<= 0` disables the timer entirely. */
  intervalHours: number;
  /** Test seam for the sweep core. */
  run?: typeof runRelayOrphanSweep;
}

/** Default min gap between emergency prune runs (issue #2344). */
export const DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS = 60 * 60 * 1000;

export interface MaintenancePruneScheduleConfig {
  /** Absolute path to the Kookr data directory to sweep. */
  dataDir: string;
  /** Interval between sweeps, in hours. `<= 0` disables the timer entirely. */
  intervalHours: number;
  /** Age threshold forwarded to the prune core. Defaults to the core's default. */
  maxAgeDays?: number;
  /** Keep-last-K protection for playbook-state runs, forwarded to the core. */
  playbookStateKeepLast?: number;
  /** Test seam for the prune core. */
  run?: typeof planAndPruneMaintenance;
  /** Injectable clock forwarded to the prune core (tests). */
  now?: () => number;
  /**
   * Aged terminal task-record pruning (issue #1526 Phase C / C2). Wired at
   * bootstrap to `pruneAgedTaskRecords` over the live TaskStore/Monitor so
   * the in-memory record map — and, via the next periodic save, `tasks.json`
   * — sheds terminal tasks older than the retention window on the same
   * maintenance tick as the disk sweep. Optional so existing wirings and
   * tests are unchanged.
   */
  pruneTaskRecords?: () => Promise<{
    outcome: 'pruned' | 'snapshot_failed';
    prunedTaskIds: string[];
    remainingTasks: number;
    maxAgeDays: number;
  }>;
  /** Fired after ≥1 record was pruned — bootstrap broadcasts a fresh snapshot. */
  onTaskRecordsPruned?: (result: { prunedTaskIds: string[]; remainingTasks: number }) => void;
  /**
   * Payload-diet observability (issue #1526 Phase C / C2): when wired, one
   * stats line is logged after every sweep so operators can watch the diet
   * working. Bootstrap also logs the same line once at boot.
   */
  getPayloadDietStats?: () => PayloadDietStats;
}

/**
 * Health projection for emergency maintenance prune (issue #2344).
 * Served under `GET /api/health.maintenancePrune`.
 */
export interface EmergencyMaintenancePruneHealthSnapshot {
  emergencyPruneTriggeredTotal: number;
  lastEmergencyPruneAt: string | null;
  lastReclaimedBytes: number | null;
  /** Configured min gap between emergency runs (ms). */
  throttleMs: number;
}

export type EmergencyPruneOutcome = 'ran' | 'throttled' | 'in_flight' | 'failed';

export interface EmergencyMaintenancePruneControllerOptions {
  /**
   * Prune config reused by the emergency path. `intervalHours` is ignored —
   * emergency runs are edge-triggered, not interval-scheduled.
   */
  pruneConfig: MaintenancePruneScheduleConfig;
  /**
   * Min gap between emergency runs. Defaults to
   * {@link DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS} (1 hour).
   */
  throttleMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Edge-triggered, rate-limited emergency data-directory prune (issue #2344).
 *
 * When disk-critical launch admission first engages, call
 * {@link EmergencyMaintenancePruneController.maybeRunOnDiskCriticalEdge} once.
 * At most one sweep runs per throttle window so a sustained critical state
 * cannot thrash the disk. Reuses {@link runScheduledMaintenancePrune} so the
 * disk + optional task-record legs stay identical to the opt-in schedule.
 *
 * Never blocks the launch path: production wiring fire-and-forgets the
 * promise. Failures are logged inside the shared prune runner.
 */
export class EmergencyMaintenancePruneController {
  private readonly throttleMs: number;
  private readonly now: () => number;
  private emergencyPruneTriggeredTotal = 0;
  private lastEmergencyPruneAt: string | null = null;
  private lastReclaimedBytes: number | null = null;
  /** Epoch-ms of the last started run, or `null` before the first. */
  private lastRunStartedAtMs: number | null = null;
  private inFlight = false;

  constructor(private readonly options: EmergencyMaintenancePruneControllerOptions) {
    this.throttleMs = Math.max(
      0,
      Math.floor(options.throttleMs ?? DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS),
    );
    this.now = options.now ?? Date.now;
  }

  getHealthSnapshot(): EmergencyMaintenancePruneHealthSnapshot {
    return {
      emergencyPruneTriggeredTotal: this.emergencyPruneTriggeredTotal,
      lastEmergencyPruneAt: this.lastEmergencyPruneAt,
      lastReclaimedBytes: this.lastReclaimedBytes,
      throttleMs: this.throttleMs,
    };
  }

  /**
   * Attempt one emergency prune for a disk-critical edge. Safe to call on
   * every edge (and even on non-edges) — throttle / in-flight gates drop
   * redundant invocations. Awaits the sweep for tests; production should
   * `void` the promise so admission never waits on reclaim.
   */
  async maybeRunOnDiskCriticalEdge(): Promise<EmergencyPruneOutcome> {
    if (this.inFlight) return 'in_flight';
    const nowMs = this.now();
    if (
      this.lastRunStartedAtMs != null
      && this.throttleMs > 0
      && nowMs - this.lastRunStartedAtMs < this.throttleMs
    ) {
      return 'throttled';
    }

    this.inFlight = true;
    this.lastRunStartedAtMs = nowMs;
    this.emergencyPruneTriggeredTotal += 1;
    this.lastEmergencyPruneAt = new Date(nowMs).toISOString();

    try {
      console.log(
        `[maintenance-prune] emergency sweep triggered by data-directory disk-critical ` +
          `(total=${this.emergencyPruneTriggeredTotal}, throttleMs=${this.throttleMs})`,
      );
      const result = await runScheduledMaintenancePrune(this.options.pruneConfig);
      if (result) {
        this.lastReclaimedBytes = result.reclaimedBytes;
        return 'ran';
      }
      // Failed attempt: do not leave a prior success's reclaim figure as if it
      // belonged to this run (health couples lastAt with lastReclaimedBytes).
      this.lastReclaimedBytes = null;
      return 'failed';
    } catch (err) {
      // runScheduledMaintenancePrune already catches; this is belt-and-braces.
      console.error('[maintenance-prune] emergency sweep failed:', err);
      this.lastReclaimedBytes = null;
      return 'failed';
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * Resolve the emergency-prune throttle (ms) from the environment.
 * Default 1 hour; `0` disables the throttle (every edge may run — tests only).
 * Invalid / blank values fall back to the default.
 */
export function resolveEmergencyPruneThrottleMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.KOOKR_EMERGENCY_PRUNE_THROTTLE_MS?.trim();
  if (!raw) return DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS;
  return Math.floor(value);
}

/** Snapshot of the payload-diet health counters (issue #1526 Phase C / C2). */
export interface PayloadDietStats {
  /** Task records currently tracked in the store (the `/api/health` `agents` count). */
  trackedTasks: number;
  /** Of which in terminal status. */
  terminalTasks: number;
  /** Serialized bytes of the most recent `all`-scope snapshot broadcast, or null before the first. */
  lastSnapshotBytes: number | null;
}

/** One-line operator-facing payload-diet stats record. */
export function formatPayloadDietLogLine(stats: PayloadDietStats): string {
  const snapshot = stats.lastSnapshotBytes === null
    ? 'none yet'
    : `${stats.lastSnapshotBytes} bytes`;
  return (
    `[payload-diet] tracked task records=${stats.trackedTasks} `
    + `(terminal=${stats.terminalTasks}); last snapshot broadcast=${snapshot}`
  );
}

/** Resolve the scheduled-prune interval (hours) from the environment.
 *  Returns 0 (off) when unset, non-numeric, or non-positive — the safe default:
 *  scheduling is strictly opt-in. */
export function resolveMaintenancePruneIntervalHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * Run one scheduled maintenance prune. Errors are caught and logged — a failed
 * sweep must never bubble into the interval callback and crash the process.
 * Returns the result, or `null` when the sweep threw.
 */
export async function runScheduledMaintenancePrune(
  config: MaintenancePruneScheduleConfig,
): Promise<MaintenancePruneResult | null> {
  try {
    const run = config.run ?? planAndPruneMaintenance;
    const result = await run({
      dataDir: config.dataDir,
      maxAgeDays: config.maxAgeDays,
      playbookStateKeepLast: config.playbookStateKeepLast,
      dryRun: false,
      ...(config.now ? { now: config.now } : {}),
    });
    const warn = result.warnings.length > 0 ? `; ${result.warnings.length} warning(s)` : '';
    console.log(
      `[maintenance-prune] scheduled sweep reclaimed ${result.reclaimedBytes} byte(s) ` +
        `across ${result.removed.length} artifact(s)${warn}`,
    );
    await runScheduledTaskRecordPrune(config);
    return result;
  } catch (err) {
    // Non-fatal: log and keep the server running.
    console.error('[maintenance-prune] scheduled sweep failed:', err);
    await runScheduledTaskRecordPrune(config);
    return null;
  }
}

/**
 * Run one scheduled relay-orphan sweep (issue #1723). Errors are caught and
 * logged so a failed sweep can never bubble into the interval callback and
 * crash the process.
 */
export async function runScheduledRelayOrphanSweep(
  config: RelayOrphanSweepScheduleConfig,
): Promise<void> {
  try {
    const run = config.run ?? runRelayOrphanSweep;
    await run({ excludePids: new Set([process.pid]) });
  } catch (err) {
    // Non-fatal: log and keep the server running.
    console.error('[relay-orphan-sweep] scheduled sweep failed:', err);
  }
}

/**
 * Aged terminal task-record prune leg of the scheduled maintenance sweep
 * (issue #1526 Phase C / C2). Isolated from the disk sweep so either leg
 * failing never suppresses the other; always finishes with the payload-diet
 * stats line when the stats provider is wired.
 */
async function runScheduledTaskRecordPrune(config: MaintenancePruneScheduleConfig): Promise<void> {
  if (config.pruneTaskRecords) {
    try {
      const result = await config.pruneTaskRecords();
      if (result.outcome === 'snapshot_failed') {
        console.error('[maintenance-prune] task-record prune skipped: predelete snapshot failed');
      } else {
        console.log(
          `[maintenance-prune] task-record prune removed ${result.prunedTaskIds.length} aged ` +
            `terminal task record(s) (> ${result.maxAgeDays}d); ${result.remainingTasks} remain`,
        );
        if (result.prunedTaskIds.length > 0) config.onTaskRecordsPruned?.(result);
      }
    } catch (err) {
      console.error('[maintenance-prune] task-record prune failed:', err);
    }
  }
  if (config.getPayloadDietStats) {
    try {
      console.log(formatPayloadDietLogLine(config.getPayloadDietStats()));
    } catch (err) {
      console.warn('[payload-diet] failed to compute stats line:', err);
    }
  }
}
