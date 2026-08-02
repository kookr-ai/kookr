import type { ProviderHealthSnapshot } from '../shared/contracts/provider-health.js';

export type { ProviderHealthSnapshot };

/**
 * Producer-side recorder for the provider-pool health signals the WS1.5
 * operational-alert rule thresholds on (issue #1897 / #1699 WS1).
 *
 * This is the seam WS1.3's fallback-substitution counter and the pool-level
 * pause edge feed. Callers on the dispatch/failover path:
 *  - call {@link recordSubstitution} once per fallback substitution, and
 *  - call {@link setPaused} on the pool paused→resumed edges.
 *
 * {@link snapshot} returns the current monotonic counter and paused-since edge;
 * the {@link OperationalAlertEvaluator} does all windowing and thresholding, so
 * this stays a dumb accumulator with no timers or config of its own.
 */
export class ProviderHealthTracker {
  private substitutionCount = 0;
  private pausedSince: number | null = null;

  /** Record `count` (default 1) fallback substitutions. */
  recordSubstitution(count = 1): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.substitutionCount += Math.trunc(count);
  }

  /**
   * Mark the provider pool paused (from `atMs`) or resumed. The first paused
   * edge latches `pausedSince`; subsequent paused calls while already paused
   * keep the original edge so the evaluator measures the full pause duration.
   */
  setPaused(paused: boolean, atMs: number): void {
    if (paused) {
      if (this.pausedSince === null && Number.isFinite(atMs)) {
        this.pausedSince = atMs;
      }
      return;
    }
    this.pausedSince = null;
  }

  snapshot(): ProviderHealthSnapshot {
    return {
      substitutionCount: this.substitutionCount,
      pausedSince: this.pausedSince,
    };
  }
}
