/**
 * In-memory per-agent-type launch outcome counters (issue #1808).
 *
 * Surfaces launch-failure rate without log spelunking: operators hit
 * `GET /api/diagnostics/launch-outcomes` after a flaky handshake wave and see
 * grok-build vs claude-code rates side by side. Process-local only (resets on
 * restart); cardinality is bounded by the small AgentType set.
 */

export const LAUNCH_OUTCOMES_ROUTE = '/api/diagnostics/launch-outcomes';
export const LAUNCH_OUTCOME_METRICS_SCHEMA_VERSION = 'launch-outcome-metrics.v1' as const;

export type LaunchOutcome = 'success' | 'failure';

export interface LaunchOutcomeSample {
  agentType: string;
  outcome: LaunchOutcome;
  /** Optional short failure class for operators (e.g. `handshake_timeout`). */
  reason?: string;
}

export interface LaunchOutcomeAgentMetric {
  agentType: string;
  attempts: number;
  successes: number;
  failures: number;
  /** failures / attempts, or 0 when attempts is 0. */
  failureRate: number;
  /** Most recent failure reason observed for this agent type, when any. */
  lastFailureReason?: string;
}

export interface LaunchOutcomeMetricsSnapshot {
  schemaVersion: typeof LAUNCH_OUTCOME_METRICS_SCHEMA_VERSION;
  totalAttempts: number;
  totalSuccesses: number;
  totalFailures: number;
  byAgentType: LaunchOutcomeAgentMetric[];
}

interface AgentBucket {
  successes: number;
  failures: number;
  lastFailureReason?: string;
}

export class LaunchOutcomeMetrics {
  private readonly byAgent = new Map<string, AgentBucket>();

  record(sample: LaunchOutcomeSample): void {
    const agentType = normalizeAgentType(sample.agentType);
    if (!agentType) return;
    let bucket = this.byAgent.get(agentType);
    if (!bucket) {
      bucket = { successes: 0, failures: 0 };
      this.byAgent.set(agentType, bucket);
    }
    if (sample.outcome === 'success') {
      bucket.successes += 1;
      return;
    }
    bucket.failures += 1;
    if (sample.reason) {
      bucket.lastFailureReason = sample.reason.slice(0, 200);
    }
  }

  snapshot(): LaunchOutcomeMetricsSnapshot {
    const byAgentType: LaunchOutcomeAgentMetric[] = [...this.byAgent.entries()]
      .map(([agentType, bucket]) => {
        const attempts = bucket.successes + bucket.failures;
        return {
          agentType,
          attempts,
          successes: bucket.successes,
          failures: bucket.failures,
          failureRate: attempts === 0 ? 0 : bucket.failures / attempts,
          ...(bucket.lastFailureReason ? { lastFailureReason: bucket.lastFailureReason } : {}),
        };
      })
      .sort(
        (a, b) =>
          b.failures - a.failures ||
          b.attempts - a.attempts ||
          a.agentType.localeCompare(b.agentType),
      );

    let totalSuccesses = 0;
    let totalFailures = 0;
    for (const row of byAgentType) {
      totalSuccesses += row.successes;
      totalFailures += row.failures;
    }

    return {
      schemaVersion: LAUNCH_OUTCOME_METRICS_SCHEMA_VERSION,
      totalAttempts: totalSuccesses + totalFailures,
      totalSuccesses,
      totalFailures,
      byAgentType,
    };
  }
}

export function emptyLaunchOutcomeMetricsSnapshot(): LaunchOutcomeMetricsSnapshot {
  return {
    schemaVersion: LAUNCH_OUTCOME_METRICS_SCHEMA_VERSION,
    totalAttempts: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    byAgentType: [],
  };
}

/** Classify a launch error for the optional `reason` field (best-effort). */
export function classifyLaunchFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/did not acknowledge the initial prompt|Initial prompt submission was not confirmed/i.test(message)) {
    return 'handshake_timeout';
  }
  if (/agent-boot did not complete within/i.test(message)) {
    return 'agent_boot_timeout';
  }
  if (/launch timed out|LaunchTimeout/i.test(message)) {
    return 'launch_timeout';
  }
  if (/startup screen|GrokLaunchRefused|kill switch|authentication/i.test(message)) {
    return 'launch_refused';
  }
  return 'launch_error';
}

function normalizeAgentType(agentType: string): string {
  const normalized = agentType.trim();
  if (!normalized) return '';
  return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
}
