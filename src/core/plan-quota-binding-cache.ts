/**
 * In-process binding-window cache for Anthropic plan-quota exhaustion
 * (issue #1936).
 *
 * After a live quota-headroom sample denies claude-code, further launches
 * within the binding window must not re-poll Anthropic on every spawn attempt
 * (reject thrash under feeder / drive-loop pressure). Cache the deny until the
 * binding window's `resetsAt` (or a short fallback cooldown when the sample
 * has no reset timestamp).
 *
 * Process-local only — same posture as {@link RelaunchArbiter}: a restart
 * clears the cache and the next live poll re-establishes state.
 */

import type { QuotaHeadroomAdmissionDecision } from './quota-headroom-admission.js';

/**
 * Fallback cache TTL when the live sample has no `resetsAt`. Long enough to
 * absorb N rapid reject retries without locking out claude-code for a full
 * plan window when the API omitted the reset field.
 */
export const PLAN_QUOTA_UNKNOWN_RESET_COOLDOWN_MS = 60_000;

export interface PlanQuotaBindingSnapshot {
  /** Epoch-ms when the binding window ends (exclusive). */
  untilMs: number;
  maxUtilization: number;
  threshold: number;
  /** Original ISO reset string when known; null when using the fallback TTL. */
  resetsAt: string | null;
}

/**
 * Mutable binding-window cache. Injected into launch-service so tests own the
 * lifetime; production wires one process-wide instance next to QuotaAdapter.
 */
export class PlanQuotaBindingCache {
  private entry: PlanQuotaBindingSnapshot | null = null;

  /** True while a previous exhausted sample is still within its binding window. */
  isBound(now: number = Date.now()): boolean {
    if (!this.entry) return false;
    if (now >= this.entry.untilMs) {
      this.entry = null;
      return false;
    }
    return true;
  }

  /**
   * Snapshot of the active binding, or null when unbound / expired.
   * Reading an expired entry clears it (same as {@link isBound}).
   */
  get(now: number = Date.now()): PlanQuotaBindingSnapshot | null {
    if (!this.isBound(now)) return null;
    return this.entry;
  }

  /**
   * Record a deny decision. Prefer the sample's `resetsAt` as the cache end;
   * fall back to {@link PLAN_QUOTA_UNKNOWN_RESET_COOLDOWN_MS} when absent or
   * unparseable / already in the past.
   */
  markExhausted(
    decision: Pick<QuotaHeadroomAdmissionDecision, 'maxUtilization' | 'threshold' | 'resetsAt'>,
    now: number = Date.now(),
  ): void {
    let untilMs = now + PLAN_QUOTA_UNKNOWN_RESET_COOLDOWN_MS;
    let resetsAt: string | null = null;
    if (typeof decision.resetsAt === 'string' && decision.resetsAt.length > 0) {
      const parsed = Date.parse(decision.resetsAt);
      if (Number.isFinite(parsed) && parsed > now) {
        untilMs = parsed;
        resetsAt = decision.resetsAt;
      }
    }
    this.entry = {
      untilMs,
      maxUtilization: decision.maxUtilization,
      threshold: decision.threshold,
      resetsAt,
    };
  }

  /** Test / operator seam — drop the cached deny immediately. */
  clear(): void {
    this.entry = null;
  }
}
