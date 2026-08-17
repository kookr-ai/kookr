/**
 * Launch-dialog copy for the existing Claude plan-quota gate.
 *
 * The server already refuses or rotates a `claude-code` launch when either
 * plan window is at/above `quotaHeadroomThreshold`. This helper does not
 * change that admission — it only describes the same
 * {@link evaluateQuotaHeadroomAdmission} decision so the Launch dialog can
 * warn before submit.
 */

import {
  evaluateQuotaHeadroomAdmission,
  QUOTA_NO_HEADROOM_UTILIZATION,
  type QuotaBindingWindow,
  type QuotaHeadroomSample,
} from './quota-headroom-admission.js';
import {
  resolveRoundRobinAgent,
  type AgentSelection,
  type AgentType,
} from '../shared/contracts/agent-types.js';

/** Same five-minute staleness the status-bar quota pills already use. */
export const QUOTA_STATUS_STALE_MS = 5 * 60 * 1000;

export interface LaunchQuotaSample {
  fiveHour: { utilization: number; resetsAt?: string } | null;
  sevenDay: { utilization: number; resetsAt?: string } | null;
  updatedAt: number;
}

export interface LaunchQuotaWarning {
  /** Operator-facing banner text. */
  message: string;
  bindingWindow: QuotaBindingWindow;
  utilization: number;
  threshold: number;
  resetsAt: string | null;
  stale: boolean;
}

export interface DescribeLaunchQuotaWarningInput {
  selection: AgentSelection;
  available: readonly AgentType[];
  /** Next round-robin cursor; ignored unless `selection` is `round-robin`. */
  roundRobinIndex?: number;
  quota: LaunchQuotaSample | null | undefined;
  /** Live `settings.quotaHeadroomThreshold`. Default matches the server gate. */
  threshold?: number;
  nowMs?: number;
}

/**
 * True when this picker selection would launch Claude Code — directly, or as
 * the next round-robin pick. Matches the server gate, which only inspects
 * `claude-code` launches.
 */
export function selectionMayLaunchClaudeCode(
  selection: AgentSelection,
  available: readonly AgentType[],
  roundRobinIndex: number = 0,
): boolean {
  if (selection === 'claude-code') return true;
  if (selection !== 'round-robin') return false;
  return resolveRoundRobinAgent(roundRobinIndex, available) === 'claude-code';
}

function windowLabel(window: QuotaBindingWindow): string {
  return window === 'fiveHour' ? '5-hour' : '7-day';
}

/** Relative reset phrasing used by the banner (and unit-tested with a frozen now). */
export function formatQuotaResetPhrase(resetsAt: string, nowMs: number): string | null {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return 'resets now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24) {
    return remainMins > 0 ? `resets in ${hours}h ${remainMins}m` : `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `resets in ${days}d`;
}

function formatStalePhrase(updatedAt: number, nowMs: number): string | null {
  const ageMs = nowMs - updatedAt;
  if (!Number.isFinite(ageMs) || ageMs < QUOTA_STATUS_STALE_MS) return null;
  const minutes = Math.max(5, Math.floor(ageMs / 60_000));
  return `This reading is ${minutes} minutes old.`;
}

function toSample(quota: LaunchQuotaSample): QuotaHeadroomSample {
  return {
    fiveHour: quota.fiveHour,
    sevenDay: quota.sevenDay,
  };
}

/**
 * Build a Launch-dialog warning when the live quota sample would make the
 * server rotate or deny this selection. Returns null when the evaluator
 * would admit, quota data is missing, or the chosen agent cannot be Claude
 * Code.
 */
export function describeLaunchQuotaWarning(
  input: DescribeLaunchQuotaWarningInput,
): LaunchQuotaWarning | null {
  const {
    selection,
    available,
    roundRobinIndex = 0,
    quota,
    threshold = QUOTA_NO_HEADROOM_UTILIZATION,
    nowMs = Date.now(),
  } = input;

  if (!quota) return null;
  if (!selectionMayLaunchClaudeCode(selection, available, roundRobinIndex)) return null;

  const decision = evaluateQuotaHeadroomAdmission(toSample(quota), threshold);
  if (decision.admit || !decision.bindingWindow) return null;

  const utilization = Math.round(decision.maxUtilization);
  const resetPhrase = decision.resetsAt
    ? formatQuotaResetPhrase(decision.resetsAt, nowMs)
    : null;
  const stalePhrase = formatStalePhrase(quota.updatedAt, nowMs);
  const resetClause = resetPhrase ? ` (${resetPhrase})` : '';
  const staleClause = stalePhrase ? ` ${stalePhrase}` : '';

  return {
    message:
      `Claude plan quota is at ${utilization}% on the ${windowLabel(decision.bindingWindow)} ` +
      `window${resetClause}. Launch will rotate to the configured fallback or be ` +
      `denied if none is allowed.${staleClause}`,
    bindingWindow: decision.bindingWindow,
    utilization: decision.maxUtilization,
    threshold: decision.threshold,
    resetsAt: decision.resetsAt,
    stale: stalePhrase !== null,
  };
}
