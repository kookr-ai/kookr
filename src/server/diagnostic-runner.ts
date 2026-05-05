/**
 * Server-layer runner for the self-diagnostic.
 *
 * Owns:
 * - The periodic timer
 * - Counter gathering from subsystems
 * - The previous counter snapshot (for window-delta computation)
 * - The latest DiagnosticReport
 *
 * Does NOT own broadcast policy — the onReport callback is the seam.
 * See docs/rfc/rfc-self-diagnostic-rate-anomalies.md
 */

import { runDiagnostic, type DiagnosticInput, type DiagnosticReport, type PreviousSnapshot } from '../core/self-diagnostic.js';
import type { DetectionStats } from '../core/detection-stats.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiagnosticRunnerDeps {
  getDetectionStats: () => DetectionStats;
  getAgentCount: () => number;
  getUptimeMs: () => number;
  getWsBroadcastCount: () => number;
  getEventCounts: () => Record<string, number>;
  /** Measures snapshot size by serializing the current snapshot message.
   *  Called once per diagnostic tick — not a free accessor. */
  measureSnapshotSizeBytes: () => number;
  /** Called by the periodic timer when findings are non-empty. */
  onReport: (report: DiagnosticReport) => void;
}

export interface DiagnosticStatus {
  report: DiagnosticReport | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export class DiagnosticRunner {
  private latestReport: DiagnosticReport | null = null;
  private lastError: string | null = null;
  private previousSnapshot: PreviousSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: DiagnosticRunnerDeps) {}

  /** Start the periodic timer. The runner owns the interval. */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return; // already started
    this.timer = setInterval(() => this.tick(), intervalMs);
    // Don't run immediately — wait for counters to accumulate
  }

  /**
   * Run the diagnostic on-demand. Returns the report.
   * Does NOT call onReport — the caller gets the response directly.
   */
  runNow(): DiagnosticReport {
    const input = this.gatherInput();
    const report = runDiagnostic(input, this.previousSnapshot);
    this.latestReport = report;
    this.lastError = null;
    this.previousSnapshot = this.toSnapshot(input);
    return report;
  }

  /** Get the latest report and health status (for GET endpoint and WS initial burst). */
  getStatus(): DiagnosticStatus {
    return {
      report: this.latestReport,
      lastError: this.lastError,
    };
  }

  /** Stop the timer. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private tick(): void {
    try {
      const input = this.gatherInput();
      const report = runDiagnostic(input, this.previousSnapshot);
      this.latestReport = report;
      this.lastError = null;
      this.previousSnapshot = this.toSnapshot(input);

      if (report.findings.length > 0) {
        this.deps.onReport(report);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      console.error('[self-diagnostic] failed to run:', message);
    }
  }

  private gatherInput(): DiagnosticInput {
    return {
      uptimeMs: this.deps.getUptimeMs(),
      agentCount: this.deps.getAgentCount(),
      detectionStats: this.deps.getDetectionStats(),
      wsBroadcastCount: this.deps.getWsBroadcastCount(),
      eventCounts: this.deps.getEventCounts(),
      lastSnapshotSizeBytes: this.deps.measureSnapshotSizeBytes(),
    };
  }

  private toSnapshot(input: DiagnosticInput): PreviousSnapshot {
    return {
      timestamp: Date.now(),
      detectionStats: input.detectionStats,
      wsBroadcastCount: input.wsBroadcastCount,
      eventCounts: { ...input.eventCounts },
    };
  }
}
