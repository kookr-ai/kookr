/**
 * Live quota-headroom admission (issue #1894 / #1699 WS1.2).
 *
 * Lives in `shared/` so the Launch dialog can reuse the same evaluator as
 * the server without the frontend importing `core/`.
 *
 * `QuotaAdapter` historically fed the dashboard only (periodic `poll()` →
 * `quotaStatus` broadcast). Launch gating never consulted it, so a claude-code
 * launch into an exhausted Anthropic plan window was admitted and then failed
 * mid-run. This module is the pure decision core for a headroom gate that the
 * launch service wires next to host-load admission.
 *
 * Design notes:
 * - Threshold matches {@link BINDING_WINDOW_UTILIZATION} in the provider-reset
 *   scheduler (90): a window at/above that utilization is treated as exhausted
 *   / binding, so admitting another launch would race the same wall.
 * - Fail-open: a missing sample (live poll failed / adapter unwired) admits.
 *   Stale `getLatest()` snapshots must never reach this function — the adapter's
 *   `getLiveHeadroom()` returns null when the live poll did not succeed.
 * - Either window can bind: deny if max(fiveHour, sevenDay) utilization is at
 *   or above the threshold.
 */

/** Utilization (0–100) at/above which a window has no remaining headroom. */
export const QUOTA_NO_HEADROOM_UTILIZATION = 90;

/** Minimal live sample — utilization only; resetsAt is optional for messaging. */
export interface QuotaHeadroomSample {
  fiveHour: { utilization: number; resetsAt?: string } | null;
  sevenDay: { utilization: number; resetsAt?: string } | null;
}

/** Which plan window produced {@link QuotaHeadroomAdmissionDecision.maxUtilization}. */
export type QuotaBindingWindow = 'fiveHour' | 'sevenDay';

export interface QuotaHeadroomAdmissionDecision {
  /** True when the launch should be admitted (no sample, or under threshold). */
  admit: boolean;
  /**
   * Highest utilization seen across known windows (`0` when no usable window).
   */
  maxUtilization: number;
  /** Threshold the decision compared against. */
  threshold: number;
  /**
   * Reset time of the binding (highest-utilization exhausted) window, when
   * known — so callers can surface "retry after …" without re-deriving it.
   */
  resetsAt: string | null;
  /**
   * Window that produced {@link maxUtilization}. Null when no usable window
   * was present (fail-open / missing data). Admission is unchanged; this is
   * for operator copy only.
   */
  bindingWindow: QuotaBindingWindow | null;
}

/**
 * Decide whether a claude-code launch should be admitted given a *live* quota
 * sample. `sample === null` fails open (admit). A non-finite utilization on a
 * window is ignored so a bad field never wedges the spawn path shut.
 */
export function evaluateQuotaHeadroomAdmission(
  sample: QuotaHeadroomSample | null | undefined,
  threshold: number = QUOTA_NO_HEADROOM_UTILIZATION,
): QuotaHeadroomAdmissionDecision {
  if (!sample) {
    return { admit: true, maxUtilization: 0, threshold, resetsAt: null, bindingWindow: null };
  }
  // Non-positive threshold disables the gate (mirrors host-load opt-out).
  if (!(threshold > 0)) {
    return { admit: true, maxUtilization: 0, threshold: 0, resetsAt: null, bindingWindow: null };
  }

  let maxUtilization = 0;
  let resetsAt: string | null = null;
  let bindingWindow: QuotaBindingWindow | null = null;
  const windows: Array<{ key: QuotaBindingWindow; window: QuotaHeadroomSample['fiveHour'] }> = [
    { key: 'fiveHour', window: sample.fiveHour },
    { key: 'sevenDay', window: sample.sevenDay },
  ];
  for (const { key, window } of windows) {
    if (!window) continue;
    if (!Number.isFinite(window.utilization)) continue;
    if (window.utilization >= maxUtilization) {
      maxUtilization = window.utilization;
      resetsAt = typeof window.resetsAt === 'string' ? window.resetsAt : null;
      bindingWindow = key;
    }
  }

  return {
    admit: maxUtilization < threshold,
    maxUtilization,
    threshold,
    resetsAt,
    bindingWindow,
  };
}
