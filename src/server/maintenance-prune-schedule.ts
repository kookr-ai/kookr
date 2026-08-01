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
