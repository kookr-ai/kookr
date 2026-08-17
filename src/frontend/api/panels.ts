import { fetchResult, getJson, apiFetch, type ApiResult } from './client.js';
import type { CostComparisonResponse } from '../../shared/contracts/cost-comparison.js';
import type { OutcomeLedgerResponse } from '../../shared/contracts/outcome-ledger.js';
import type { TimeToUnblockSnapshot } from '../../shared/contracts/time-to-unblock.js';

export interface CostComparisonQuery {
  window: string;
  /** Agent filter; omit or pass 'all' to include every agent. */
  agent?: string;
  /** Free-text search term. */
  q?: string;
}

/** GET the cost-comparison surface. Throws `HTTP <status>` on a non-2xx. */
export function getCostComparison(
  query: CostComparisonQuery,
  signal?: AbortSignal,
): Promise<CostComparisonResponse> {
  const params = new URLSearchParams({ window: query.window });
  if (query.agent && query.agent !== 'all') params.set('agent', query.agent);
  if (query.q) params.set('q', query.q);
  return getJson<CostComparisonResponse>(`/api/cost-comparison?${params.toString()}`, { signal });
}

/**
 * GET the outcome-ledger surface for a window. Throws `HTTP <status>` on a
 * non-2xx; the caller validates the body shape.
 */
export function getOutcomeLedger(
  windowChoice: string,
  signal?: AbortSignal,
): Promise<OutcomeLedgerResponse> {
  return getJson<OutcomeLedgerResponse>(`/api/outcome-ledger?window=${windowChoice}`, { signal });
}

/** GET anomaly-detection stats. Throws `HTTP <status>` on a non-2xx. */
export function getAnomalyStats<T>(signal?: AbortSignal): Promise<T> {
  return getJson<T>('/api/anomaly-stats', { signal });
}

/** POST to run the diagnostic sweep now. Returns status + parsed report body. */
export function runDiagnostic(): Promise<ApiResult<{ report?: unknown } | null>> {
  return fetchResult<{ report?: unknown }>('/api/diagnostic/run', { method: 'POST' });
}

/**
 * GET the session-health diagnostics surface. Returns the parsed body (the
 * caller validates its shape) and throws with the panel's label on a non-2xx.
 */
export async function getSessionHealth(): Promise<unknown> {
  const res = await apiFetch('/api/diagnostics/session-health');
  if (!res.ok) throw new Error(`session health request failed: ${res.status}`);
  return (await res.json()) as unknown;
}

/** GET the live-friction calibration snapshot. Throws `HTTP <status>` on a non-2xx. */
export function getLiveFrictionCalibration<T>(): Promise<T> {
  return getJson<T>('/api/live-friction-calibration');
}

/** GET the finding-evidence operations diagnostics. Throws `HTTP <status>` on a non-2xx. */
export function getFindingEvidenceOperationsDiagnostics<T>(signal: AbortSignal): Promise<T> {
  return getJson<T>('/api/finding-evidence-operations-diagnostics', { signal });
}

/**
 * GET the 24-hour median human-reply wait (issue #2583). Throws `HTTP <status>`
 * on a non-2xx; the StatusBar chip hides itself when this fails or when
 * `sampleCount` is below five.
 */
export function getTimeToUnblock(signal?: AbortSignal): Promise<TimeToUnblockSnapshot> {
  return getJson<TimeToUnblockSnapshot>('/api/diagnostics/time-to-unblock', {
    cache: 'no-store',
    signal,
  });
}
