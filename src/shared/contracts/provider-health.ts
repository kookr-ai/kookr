/**
 * Provider-pool health snapshot (issue #1897, WS1.5 of #1699 — provider-resilient
 * dispatch / failover spine).
 *
 * Failover can silently mask a chronic provider outage: repeated fallback
 * substitutions, or a long provider-pool pause, keep the pipeline limping while
 * hiding that the pool is degraded. This snapshot exposes the two raw signals a
 * standing operational alert thresholds on — a monotonic substitution counter
 * and the epoch-ms the pool entered its current paused state — decoupled from
 * however the dispatch layer measures them.
 *
 * The substitution counter is produced by WS1.3 (fallback-substitution counter)
 * and the paused edge by the pool-level pause tracking; this contract is the
 * seam both feed and the {@link OperationalAlertEvaluator} reads.
 */
export interface ProviderHealthSnapshot {
  /**
   * Monotonic count of provider fallback substitutions since process start.
   * The evaluator windows deltas of this counter itself, so producers only
   * need to increment it once per substitution — no windowing on their side.
   * A decrease (e.g. a producer reset) is treated as a rebase, not N negative
   * substitutions.
   */
  substitutionCount: number;
  /**
   * Epoch milliseconds the provider pool entered its current paused/degraded
   * state, or `null` when the pool is healthy. Mirrors the circuit-breaker
   * `lastStateChange` shape so the evaluator can compute paused-duration the
   * same way it computes breaker open-duration.
   */
  pausedSince: number | null;
}
