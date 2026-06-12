/**
 * Server-layer runner for the self-diagnostic.
 *
 * Owns:
 * - Counter gathering from subsystems
 * - The previous counter snapshot (for window-delta computation)
 * - The latest DiagnosticReport
 *
 * Diagnostics are on-demand; callers decide how to expose returned reports.
 * See docs/rfc/rfc-self-diagnostic-rate-anomalies.md
 */

import { runDiagnostic, type DiagnosticInput, type DiagnosticReport, type PreviousSnapshot } from '../core/self-diagnostic.js';
import type { DetectionStats } from '../core/detection-stats.js';
import { getHelperLlmDiagnosticsSnapshot } from '../core/llm-factory.js';
import type { HelperLlmDiagnosticsSnapshot } from '../core/llm-types.js';
import type { PersistenceHealthSnapshot } from '../core/persistence-health.js';

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
   *  Called once per diagnostic run — not a free accessor. */
  measureSnapshotSizeBytes: () => number;
  /** Diagnostics-only aggregate for Kookr's own helper-LLM calls. */
  getHelperLlmDiagnosticsSnapshot?: () => HelperLlmDiagnosticsSnapshot;
  /** In-memory health for runtime persistence attempts. */
  getPersistenceHealthSnapshot?: () => PersistenceHealthSnapshot;
}

export interface DiagnosticStatus {
  report: DiagnosticReport | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class DiagnosticRunner {
  private latestReport: DiagnosticReport | null = null;
  private lastError: string | null = null;
  private previousSnapshot: PreviousSnapshot | null = null;

  constructor(private deps: DiagnosticRunnerDeps) {}

  /** Run the diagnostic on-demand. Returns the report. */
  runNow(): DiagnosticReport {
    try {
      const input = this.gatherInput();
      const report = runDiagnostic(input, this.previousSnapshot);
      this.latestReport = report;
      this.lastError = null;
      this.previousSnapshot = this.toSnapshot(input);
      return report;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Get the latest report and health status (for GET endpoint and WS initial burst). */
  getStatus(): DiagnosticStatus {
    return {
      report: this.latestReport,
      lastError: this.lastError,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private gatherInput(): DiagnosticInput {
    return {
      uptimeMs: this.deps.getUptimeMs(),
      agentCount: this.deps.getAgentCount(),
      detectionStats: this.deps.getDetectionStats(),
      wsBroadcastCount: this.deps.getWsBroadcastCount(),
      eventCounts: this.deps.getEventCounts(),
      lastSnapshotSizeBytes: this.deps.measureSnapshotSizeBytes(),
      helperLlm: (this.deps.getHelperLlmDiagnosticsSnapshot ?? getHelperLlmDiagnosticsSnapshot)(),
      persistenceHealth: this.deps.getPersistenceHealthSnapshot?.(),
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
