import { fetchResult, getJson, apiFetch, type ApiResult } from './client.js';
import type { CostComparisonResponse } from '../../shared/contracts/cost-comparison.js';
import type {
  OutcomeLedgerProjectScope,
  OutcomeLedgerResponse,
} from '../../shared/contracts/outcome-ledger.js';
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
 * GET the outcome-ledger surface for a window and project scope. Throws
 * `HTTP <status>` on a non-2xx; the caller validates the body shape.
 *
 * The `all` scope omits the `projectScope` param entirely so an unscoped
 * request stays byte-for-byte backward-compatible; `URLSearchParams` encodes
 * project IDs containing URL-significant characters so they round-trip.
 */
export function getOutcomeLedger(
  windowChoice: string,
  scope: OutcomeLedgerProjectScope = { kind: 'all' },
  signal?: AbortSignal,
): Promise<OutcomeLedgerResponse> {
  const params = new URLSearchParams({ window: windowChoice });
  if (scope.kind === 'assigned') {
    params.set('projectScope', 'assigned');
    params.set('projectId', scope.projectId);
  } else if (scope.kind === 'unassigned') {
    params.set('projectScope', 'unassigned');
  }
  return getJson<OutcomeLedgerResponse>(`/api/outcome-ledger?${params.toString()}`, { signal });
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

/**
 * GET the live-friction calibration snapshot. Throws `HTTP <status>` on a
 * non-2xx. The StatusBar chip hides itself when this fails or when the body
 * is not a `live-friction-calibration.v1` snapshot with `signalCount > 0`.
 */
export function getLiveFrictionCalibration<T>(signal?: AbortSignal): Promise<T> {
  return getJson<T>('/api/live-friction-calibration', {
    cache: 'no-store',
    signal,
  });
}

/** GET the finding-evidence operations diagnostics. Throws `HTTP <status>` on a non-2xx. */
export function getFindingEvidenceOperationsDiagnostics<T>(signal: AbortSignal): Promise<T> {
  return getJson<T>('/api/finding-evidence-operations-diagnostics', { signal });
}

/**
 * GET the 24-hour human-reply wait snapshot (issues #2583, #2609). Throws
 * `HTTP <status>` on a non-2xx; the StatusBar chip hides itself when this
 * fails or when `sampleCount` is below five. The chip label reuses
 * `sampleCount` as the unblocked volume next to the median.
 */
export function getTimeToUnblock(signal?: AbortSignal): Promise<TimeToUnblockSnapshot> {
  return getJson<TimeToUnblockSnapshot>('/api/diagnostics/time-to-unblock', {
    cache: 'no-store',
    signal,
  });
}
