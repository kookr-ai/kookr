import type { HookIngestionDiagnosticsSnapshot } from './hook-ingestion.js';

/**
 * Bounded, last-good-preserving control-plane health collection (issue #2798).
 *
 * `GET /api/health` assembles its body from a mix of cheap in-memory gauges and
 * a few disk-backed reads (retro-verify spool, pipeline-starvation state). When
 * one of those reads is slow — or the whole assembly wedges before the cache is
 * warm — the endpoint must not hang indefinitely, and it must not report the
 * fleet as empty (worker/session counts flipped to zero) merely because a
 * collection round timed out. It should instead serve the last snapshot that
 * *did* collect and label the response so an operator can tell whether the
 * values are live, a preserved last-good copy, or genuinely unavailable.
 *
 * This module holds the small, pure pieces of that policy:
 *  - {@link raceWithDeadline} / {@link collectBounded}: bound one collector by a
 *    deadline, distinguishing a timeout from a thrown error;
 *  - {@link hookLagFreshnessFromSnapshot}: the latest hook-ingestion lag plus how
 *    fresh that reading is;
 *  - {@link buildControlPlaneCollectionBlock}: the typed `controlPlane` block the
 *    route attaches to every health body.
 *
 * None of it restarts agents or the daemon — it is read-only observability.
 */

export const CONTROL_PLANE_COLLECTION_SCHEMA_VERSION = 'control-plane-collection.v1';

/** How the values in the served health body were sourced this round. */
export type ControlPlaneSource = 'live' | 'last-good' | 'unavailable';

/** Overall collection verdict for the served body. */
export type ControlPlaneCollectionStatus = 'ok' | 'degraded' | 'unavailable';

/** Latest observed hook-ingestion lag plus how fresh that reading is. */
export interface HookLagFreshness {
  /** Latest per-session hook-ingestion lag in ms (newest processed session), or null when unknown. */
  lastLagMs: number | null;
  /** ISO time of the most recently processed hook record across sessions, or null when unknown. */
  lastProcessedAt: string | null;
  /** Age of {@link lastProcessedAt} relative to now, in ms (never negative), or null when unknown. */
  ageMs: number | null;
}

export interface ControlPlaneCollectionBlock {
  schemaVersion: typeof CONTROL_PLANE_COLLECTION_SCHEMA_VERSION;
  /** Overall verdict: `ok` (live + complete), `degraded` (last-good or partial), `unavailable` (nothing to serve). */
  collectionStatus: ControlPlaneCollectionStatus;
  /** Whether the served values are live, a preserved last-good snapshot, or unavailable. */
  source: ControlPlaneSource;
  /**
   * ISO time the served snapshot was actually collected — the fresh assembly
   * time for a live body, or the captured time of the preserved snapshot for a
   * last-good body. Null when unavailable.
   */
  lastGoodAt: string | null;
  /** Age of {@link lastGoodAt} relative to now, in ms. Null when unavailable. */
  lastGoodAgeMs: number | null;
  /** Component names whose bounded collection exceeded its budget this round. */
  timedOutComponents: string[];
  /** Component names whose bounded collection threw this round. */
  erroredComponents: string[];
  /** Latest hook-ingestion lag + freshness, or null when hook ingestion is unwired. */
  hookLag: HookLagFreshness | null;
}

/** Discriminated outcome of racing one unit of work against a deadline. */
export type DeadlineResult<T> =
  | { status: 'value'; value: T }
  | { status: 'timeout' }
  | { status: 'error'; error: unknown };

/**
 * Resolve as soon as `work` settles or `signal` aborts, whichever is first.
 *
 * A rejection is reported as `error` (the collector failed on its own) and an
 * abort as `timeout` (the deadline fired first) so callers can classify the two
 * separately. The rejection handler is always attached to `work`, so a late
 * rejection after a timeout cannot surface as an unhandled rejection. The work
 * itself is not cancelled — JS promises cannot be — it simply stops being
 * awaited; a single-flight assembly keeps running to warm the next round.
 */
export function raceWithDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<DeadlineResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DeadlineResult<T>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ status: 'timeout' });
    if (signal.aborted) {
      // Already past the deadline: report timeout immediately, but still adopt
      // `work`'s eventual rejection so a pre-aborted caller cannot leak an
      // unhandled rejection (defensive — no current caller passes a pre-aborted
      // signal, since both create a fresh controller with a positive timeout).
      void work.catch(() => {});
      resolve({ status: 'timeout' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish({ status: 'value', value }),
      (error) => finish({ status: 'error', error }),
    );
  });
}

/** Provenance of one bounded component collection. */
export interface BoundedComponentResult<T> {
  name: string;
  source: 'live' | 'timed-out' | 'error';
  /** Present only when `source === 'live'`. */
  value?: T;
}

/**
 * Run one component collector under a per-component time budget.
 *
 * `live` on success, `timed-out` when the budget elapses first, `error` when the
 * collector throws (sync or async). A slow or failing collector therefore
 * degrades only itself — the rest of the health body still assembles from the
 * collectors that did complete, so worker/session counts are never zeroed just
 * because one disk-backed read stalled.
 */
export async function collectBounded<T>(
  name: string,
  produce: () => Promise<T> | T,
  budgetMs: number,
): Promise<BoundedComponentResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  // A pending health-collection timer must never keep the process alive.
  (timer as { unref?: () => void }).unref?.();
  try {
    let work: Promise<T>;
    try {
      work = Promise.resolve(produce());
    } catch {
      return { name, source: 'error' };
    }
    const outcome = await raceWithDeadline(work, controller.signal);
    if (outcome.status === 'value') return { name, source: 'live', value: outcome.value };
    if (outcome.status === 'timeout') return { name, source: 'timed-out' };
    return { name, source: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Derive the latest hook-ingestion lag and how fresh it is from the diagnostics
 * snapshot. "Latest" is the lag of the most-recently-processed session, so a
 * long-idle session's stale sample does not masquerade as current lag.
 * Returns a null-filled reading (rather than `null`) when the snapshot exists
 * but no session has processed a record yet, and `null` only when hook
 * ingestion is entirely unwired.
 */
export function hookLagFreshnessFromSnapshot(
  snapshot: Pick<HookIngestionDiagnosticsSnapshot, 'sessions'> | undefined,
  nowMs: number,
): HookLagFreshness | null {
  if (!snapshot) return null;
  let bestProcessedMs: number | null = null;
  let bestLagMs: number | null = null;
  for (const session of snapshot.sessions) {
    const processedAt = session.lastProcessedAt;
    if (!processedAt) continue;
    const ms = Date.parse(processedAt);
    if (!Number.isFinite(ms)) continue;
    if (bestProcessedMs === null || ms > bestProcessedMs) {
      bestProcessedMs = ms;
      bestLagMs = typeof session.lag?.lastMs === 'number' ? session.lag.lastMs : null;
    }
  }
  if (bestProcessedMs === null) {
    return { lastLagMs: null, lastProcessedAt: null, ageMs: null };
  }
  return {
    lastLagMs: bestLagMs,
    lastProcessedAt: new Date(bestProcessedMs).toISOString(),
    ageMs: Math.max(0, nowMs - bestProcessedMs),
  };
}

export interface ControlPlaneCollectionInput {
  /** Whether the served values are live, a preserved last-good copy, or unavailable. */
  source: ControlPlaneSource;
  /** Epoch ms the served snapshot was collected, or null when unavailable. */
  collectedAtMs: number | null;
  /** Current epoch ms, for age computation. */
  nowMs: number;
  /** Component names whose bounded collection timed out this round. */
  timedOutComponents?: string[];
  /** Component names whose bounded collection threw this round. */
  erroredComponents?: string[];
  /** Latest hook-ingestion lag + freshness, or null when unwired. */
  hookLag?: HookLagFreshness | null;
}

/**
 * Assemble the typed `controlPlane` block attached to every health body.
 *
 * `collectionStatus` is `unavailable` when there is nothing to serve,
 * `degraded` when the body is a last-good copy or any live component timed
 * out/failed, and `ok` only when the round is live and complete.
 */
export function buildControlPlaneCollectionBlock(
  input: ControlPlaneCollectionInput,
): ControlPlaneCollectionBlock {
  const timedOutComponents = input.timedOutComponents ? [...input.timedOutComponents] : [];
  const erroredComponents = input.erroredComponents ? [...input.erroredComponents] : [];
  const hasDegradedComponent = timedOutComponents.length > 0 || erroredComponents.length > 0;

  let collectionStatus: ControlPlaneCollectionStatus;
  if (input.source === 'unavailable') {
    collectionStatus = 'unavailable';
  } else if (input.source === 'last-good') {
    collectionStatus = 'degraded';
  } else {
    collectionStatus = hasDegradedComponent ? 'degraded' : 'ok';
  }

  const lastGoodAt = input.collectedAtMs !== null ? new Date(input.collectedAtMs).toISOString() : null;
  const lastGoodAgeMs =
    input.collectedAtMs !== null ? Math.max(0, input.nowMs - input.collectedAtMs) : null;

  return {
    schemaVersion: CONTROL_PLANE_COLLECTION_SCHEMA_VERSION,
    collectionStatus,
    source: input.source,
    lastGoodAt,
    lastGoodAgeMs,
    timedOutComponents,
    erroredComponents,
    hookLag: input.hookLag ?? null,
  };
}
