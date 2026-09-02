/**
 * Watchdog sweep fairness metrics (issue #2770).
 *
 * The watchdog tick checks every tracked agent in one serial pass, awaiting an
 * external pane capture and hook-file drain per agent. When one of those probes
 * hangs (a wedged terminal backend, a stuck hook drain), the old loop could
 * consume the whole 5s tick — starving every other agent of its health check
 * and, because the re-entrancy guard skips overlapping ticks, blocking recovery
 * fleet-wide.
 *
 * The fix bounds each probe with a deadline and sweeps from a rotating cursor
 * under a per-tick wall-clock budget, so a hung probe can never prevent the
 * remaining agents from being checked on this or a following tick. This class
 * is the observability surface for that behavior: it projects onto
 * `/api/health.watchdogSweep` and `/metrics` so an operator can see probe
 * timeouts, deferred (skipped) work, and the oldest-check age across the fleet.
 *
 * One instance per server process, threaded into the watchdog tick, the health
 * route, and the Prometheus exposition. Cheap in-memory counters + last-sweep
 * gauges — never a fresh scan on any request path.
 */

/** Which external probe hit its per-agent deadline. */
export type WatchdogProbeKind = 'capture' | 'drain';

/** Point-in-time result of the most recent completed sweep. */
export interface WatchdogSweepSample {
  /** Agents actually checked this sweep. */
  checked: number;
  /** Agents deferred to a following tick because the budget was exhausted. */
  skipped: number;
  /** Wall-clock duration of the sweep, ms. */
  durationMs: number;
  /**
   * Oldest time-since-last-check across currently tracked agents at the end of
   * the sweep, ms. 0 when no agent has been checked yet (or none are tracked).
   */
  oldestCheckAgeMs: number;
  /** Tracked-agent count observed at the start of the sweep. */
  trackedAgents: number;
}

/** In-memory snapshot for `/api/health.watchdogSweep` + `/metrics` (issue #2770). */
export interface WatchdogSweepMetricsSnapshot {
  /** Completed sweeps since process start. */
  sweepsTotal: number;
  /** Cumulative agents checked across all sweeps. */
  agentsCheckedTotal: number;
  /** Cumulative agent-checks deferred to a later tick because the budget ran out. */
  skippedTotal: number;
  /** Cumulative probe deadline hits (capture + drain). */
  probeTimeoutsTotal: number;
  /** Cumulative pane-capture deadline hits. */
  captureTimeoutsTotal: number;
  /** Cumulative hook-drain deadline hits. */
  drainTimeoutsTotal: number;
  /** Agents checked in the most recent sweep. */
  lastSweepCheckedCount: number;
  /** Agents deferred in the most recent sweep. */
  lastSweepSkippedCount: number;
  /** Wall-clock duration of the most recent sweep, ms. */
  lastSweepDurationMs: number;
  /** Oldest time-since-last-check across tracked agents at the last sweep, ms. */
  oldestCheckAgeMs: number;
  /** Tracked-agent count observed at the start of the most recent sweep. */
  trackedAgents: number;
}

/**
 * Process-lifetime watchdog sweep counters (issue #2770). One instance at
 * bootstrap, threaded into the watchdog tick (records), `/api/health`, and
 * `/metrics` (read-only `getSnapshot()`).
 */
export class WatchdogSweepMetrics {
  private sweepsTotal = 0;
  private agentsCheckedTotal = 0;
  private skippedTotal = 0;
  private captureTimeoutsTotal = 0;
  private drainTimeoutsTotal = 0;
  private lastSweepCheckedCount = 0;
  private lastSweepSkippedCount = 0;
  private lastSweepDurationMs = 0;
  private oldestCheckAgeMs = 0;
  private trackedAgents = 0;

  /** Record one external probe that hit its per-agent deadline. */
  recordProbeTimeout(kind: WatchdogProbeKind): void {
    if (kind === 'capture') this.captureTimeoutsTotal++;
    else this.drainTimeoutsTotal++;
  }

  /** Record a completed sweep: bumps cumulative counters and last-sweep gauges. */
  recordSweep(sample: WatchdogSweepSample): void {
    this.sweepsTotal++;
    this.agentsCheckedTotal += Math.max(0, sample.checked);
    this.skippedTotal += Math.max(0, sample.skipped);
    this.lastSweepCheckedCount = Math.max(0, sample.checked);
    this.lastSweepSkippedCount = Math.max(0, sample.skipped);
    this.lastSweepDurationMs = Math.max(0, Math.round(sample.durationMs));
    this.oldestCheckAgeMs = Math.max(0, Math.round(sample.oldestCheckAgeMs));
    this.trackedAgents = Math.max(0, sample.trackedAgents);
  }

  getSnapshot(): WatchdogSweepMetricsSnapshot {
    return {
      sweepsTotal: this.sweepsTotal,
      agentsCheckedTotal: this.agentsCheckedTotal,
      skippedTotal: this.skippedTotal,
      probeTimeoutsTotal: this.captureTimeoutsTotal + this.drainTimeoutsTotal,
      captureTimeoutsTotal: this.captureTimeoutsTotal,
      drainTimeoutsTotal: this.drainTimeoutsTotal,
      lastSweepCheckedCount: this.lastSweepCheckedCount,
      lastSweepSkippedCount: this.lastSweepSkippedCount,
      lastSweepDurationMs: this.lastSweepDurationMs,
      oldestCheckAgeMs: this.oldestCheckAgeMs,
      trackedAgents: this.trackedAgents,
    };
  }
}
