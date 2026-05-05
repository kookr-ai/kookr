import type { AnomalyType } from './types.js';

/** Anomaly types that are suppressible (liveness category). */
const LIVENESS_ANOMALY_TYPES: ReadonlySet<AnomalyType> = new Set([
  'stale_agent',
  'hook_disconnected',
]);

/** Number of consecutive liveness snoozes before auto-suppression kicks in. */
const SUPPRESSION_THRESHOLD = 3;

/** Per-agent suppression state. */
export interface SuppressionState {
  /** Number of consecutive liveness-category snoozes. */
  consecutiveCount: number;
  /** Whether monitoring is currently suppressed. */
  suppressed: boolean;
  /** The anomaly type that triggered suppression (for logging). */
  lastAnomalyType: AnomalyType;
}

/** Serialized suppression state for persistence in tasks.json. */
export interface PersistedSuppressionEntry {
  agentId: string;
  consecutiveCount: number;
  suppressed: boolean;
  lastAnomalyType: AnomalyType;
}

/**
 * Tracks consecutive liveness-category snoozes per agent and auto-suppresses
 * monitoring when the threshold is reached. This prevents "snooze storms"
 * where the same liveness finding keeps resurfacing after the user snoozes it.
 */
export class SnoozeSuppressionTracker {
  private state = new Map<string, SuppressionState>();

  /**
   * Record a snooze for the given agent and anomaly type.
   * Returns true if the threshold was just crossed (newly suppressed).
   * Non-liveness anomaly types are ignored (returns false, no state change).
   */
  recordSnooze(agentId: string, anomalyType: AnomalyType): boolean {
    if (!LIVENESS_ANOMALY_TYPES.has(anomalyType)) return false;

    const existing = this.state.get(agentId);
    const count = (existing?.consecutiveCount ?? 0) + 1;
    const wasSuppressed = existing?.suppressed ?? false;
    const nowSuppressed = count >= SUPPRESSION_THRESHOLD;

    this.state.set(agentId, {
      consecutiveCount: count,
      suppressed: nowSuppressed,
      lastAnomalyType: anomalyType,
    });

    // Return true only on the transition from not-suppressed to suppressed
    return nowSuppressed && !wasSuppressed;
  }

  /**
   * Check whether a liveness anomaly should be suppressed (not enqueued).
   * Non-liveness anomaly types always return false (never suppressed).
   */
  shouldSuppress(agentId: string, anomalyType: AnomalyType): boolean {
    if (!LIVENESS_ANOMALY_TYPES.has(anomalyType)) return false;
    return this.state.get(agentId)?.suppressed ?? false;
  }

  /** Check whether an agent is currently suppressed (for UI visibility). */
  isSuppressed(agentId: string): boolean {
    return this.state.get(agentId)?.suppressed ?? false;
  }

  /** Reset suppression state for an agent (on respond or agent cleanup). */
  reset(agentId: string): void {
    this.state.delete(agentId);
  }

  /** Get all suppressed agent IDs. */
  getSuppressedAgents(): string[] {
    const result: string[] = [];
    for (const [agentId, s] of this.state) {
      if (s.suppressed) result.push(agentId);
    }
    return result;
  }

  /** Export state for persistence. */
  export(): PersistedSuppressionEntry[] {
    const result: PersistedSuppressionEntry[] = [];
    for (const [agentId, s] of this.state) {
      result.push({
        agentId,
        consecutiveCount: s.consecutiveCount,
        suppressed: s.suppressed,
        lastAnomalyType: s.lastAnomalyType,
      });
    }
    return result;
  }

  /** Import state from persistence. */
  import(entries: PersistedSuppressionEntry[]): void {
    for (const entry of entries) {
      this.state.set(entry.agentId, {
        consecutiveCount: entry.consecutiveCount,
        suppressed: entry.suppressed,
        lastAnomalyType: entry.lastAnomalyType,
      });
    }
  }
}

/** Check whether an anomaly type is in the liveness category (suppressible). */
export function isLivenessAnomaly(type: AnomalyType): boolean {
  return LIVENESS_ANOMALY_TYPES.has(type);
}
