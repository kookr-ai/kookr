/**
 * Provider-pause classification (issue #1667).
 *
 * A delivery-owning child stalled on billing/quota is neither delivered nor
 * hung. Completing it (delivered-auto-complete, completion-ready auto-close,
 * or hung reaping) orphans in-flight branch ownership and forces the parent
 * into a human admin-merge path — the 74d1d038 / task c21629df shape.
 *
 * This module is the pure detector: given recent agent events (and optional
 * free-text surfaces such as pane / tool output), decide whether the agent is
 * provider-paused. Callers on the auto-complete paths refuse to complete when
 * this returns paused; the stuckReason / capacity surfaces expose
 * `provider_paused` so the operator sees an explicit classification rather
 * than a silent "completed" or "hung".
 *
 * Covered signals (any one is enough):
 *  - `stop_failure` with `billing_error` / rate-limit / auth-failed errors
 *  - lastMessage / tool output / pane text matching credit, quota, or
 *    GitHub Actions spending-limit / payment-failure wording (same fingerprint
 *    the CI signal classifier uses for account-level blocks)
 */

import type { AgentEvent } from './agent-events.js';

/** Explicit classification name surfaces and auto-complete reasons share. */
export const PROVIDER_PAUSED_REASON = 'provider_paused' as const;
export type ProviderPausedReason = typeof PROVIDER_PAUSED_REASON;

/**
 * stop_failure.error values that mean the agent account / provider side is
 * paused and will not make progress until a human top-up / re-auth.
 * Mirrors the critical set in anomaly-detector.ts plus rate_limit, which is a
 * soft pause that must still block "delivered" auto-complete.
 */
export const PROVIDER_PAUSE_STOP_ERRORS = new Set([
  'billing_error',
  'authentication_failed',
  'rate_limit',
  'rate_limit_error',
  'quota_exceeded',
]);

/**
 * Free-text patterns for billing / quota / spending-limit pauses. Covers both
 * agent-provider credit messages ("Credit balance is too low") and GitHub
 * Actions account-level blocks (the 74d1d038 fingerprint: spending limit /
 * recent account payments / zero-code-steps billing annotations in the pane).
 *
 * Kept as one regex so a single scan of recent text is cheap on the liveness
 * tick. Case-insensitive.
 */
export const PROVIDER_PAUSE_TEXT_RE =
  /billing_error|credit balance is too low|insufficient credits|out of credits?|quota (?:exceeded|exhausted)|rate.?limit|spending limit|recent account payments|account payment|payment (?:has |method )?fail|exceeded (?:your |the )?(?:included )?(?:quota|minutes)|out of (?:credit|minutes)|not started because|actions? (?:minutes|billing)/i;

export interface ProviderPauseEvidence {
  /** Recent agent events (newest-last preferred; order does not matter). */
  events?: readonly AgentEvent[];
  /**
   * Optional free-text surfaces (pane capture, last tool stdout, status-check
   * annotations). Any match of {@link PROVIDER_PAUSE_TEXT_RE} counts.
   */
  texts?: readonly string[];
  /**
   * Queued anomaly type for this agent (`AttentionQueue.peek` / `api_error`).
   * When paired with a billing-shaped explanation, counts as paused.
   */
  anomalyType?: string | null;
  anomalyExplanation?: string | null;
}

export interface ProviderPauseDecision {
  paused: boolean;
  /** Present only when paused — which evidence fired first. */
  reason?: ProviderPausedReason;
  /** Short human/machine detail of the matching signal. */
  detail?: string;
}

function textLooksPaused(text: string): boolean {
  return PROVIDER_PAUSE_TEXT_RE.test(text);
}

/** Flatten a tool_result payload into scannable text (string or JSON). */
function stringifyToolSurface(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Decide whether the agent is provider-paused given recent evidence.
 * Pure and side-effect free — safe to call on every liveness tick.
 */
export function classifyProviderPause(evidence: ProviderPauseEvidence): ProviderPauseDecision {
  const events = evidence.events ?? [];

  // Walk newest-first so the most recent stop_failure wins the detail string.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'stop_failure') {
      if (PROVIDER_PAUSE_STOP_ERRORS.has(event.error)) {
        return {
          paused: true,
          reason: PROVIDER_PAUSED_REASON,
          detail: `stop_failure:${event.error}`,
        };
      }
      if (event.lastMessage && textLooksPaused(event.lastMessage)) {
        return {
          paused: true,
          reason: PROVIDER_PAUSED_REASON,
          detail: `stop_failure_message:${event.error}`,
        };
      }
    }
    if (event.type === 'error' && textLooksPaused(event.message)) {
      return {
        paused: true,
        reason: PROVIDER_PAUSED_REASON,
        detail: 'error_event',
      };
    }
    // Tool results and notification messages often carry GH Actions billing
    // annotations the agent just fetched via `gh run view`.
    if (event.type === 'tool_result') {
      const surface = stringifyToolSurface(event.toolResponse);
      if (surface && textLooksPaused(surface)) {
        return {
          paused: true,
          reason: PROVIDER_PAUSED_REASON,
          detail: 'tool_result',
        };
      }
    }
    if (event.type === 'notification' && textLooksPaused(event.message)) {
      return {
        paused: true,
        reason: PROVIDER_PAUSED_REASON,
        detail: 'notification',
      };
    }
  }

  for (const text of evidence.texts ?? []) {
    if (text && textLooksPaused(text)) {
      return {
        paused: true,
        reason: PROVIDER_PAUSED_REASON,
        detail: 'text_surface',
      };
    }
  }

  if (evidence.anomalyType === 'api_error') {
    const explanation = evidence.anomalyExplanation ?? '';
    if (!explanation || textLooksPaused(explanation) || /billing|quota|credit|rate.?limit|auth/i.test(explanation)) {
      return {
        paused: true,
        reason: PROVIDER_PAUSED_REASON,
        detail: 'anomaly:api_error',
      };
    }
  }

  return { paused: false };
}

/** Convenience boolean for call sites that only need a yes/no. */
export function isProviderPaused(evidence: ProviderPauseEvidence): boolean {
  return classifyProviderPause(evidence).paused;
}
