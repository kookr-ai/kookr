import type { AnomalySeverity } from './anomalies.js';

/**
 * Maximum stored length for the free-text `notes` field. Over-long values are
 * truncated (not rejected) so a config write degrades gracefully. Aligned with
 * the sibling agent-signal note cap (`MAX_AGENT_SIGNAL_NOTE_LENGTH`, 2000) and
 * generous versus the shorter feedback-note cap, since project notes may carry
 * longer operator prose.
 */
export const MAX_PROJECT_NOTES_LENGTH = 2000;

/** Sentinel for an uncapped zero-drain issue allowance. */
export const UNLIMITED_ZERO_DRAIN_ISSUE_LIMIT = -1;

export interface ProjectWebhookRoutingSettings {
  enabled?: boolean;
  minSeverity?: AnomalySeverity;
}

export interface ProjectConfig {
  project: string;
  tracked?: boolean;
  /**
   * Max PRs per calendar day for this project (non-negative integer).
   * Manual config takes precedence over `rate-limits.json`.
   * Omitted when unset; invalid values are dropped (fall back to rate-limits).
   */
  dailyPrLimit?: number;
  /**
   * Max PRs per calendar week for this project (non-negative integer).
   * Omitted when unset; invalid values are dropped.
   */
  weeklyPrLimit?: number;
  /** Per-task cost warning threshold in USD. 0 disables budget alerts for this project. */
  budgetWarnUsd?: number;
  /**
   * Number of new issues permitted when the target repo has drained zero
   * issues in the coupling window. -1 means unlimited; 0 refuses emission.
   * Omitted values resolve to the deployment ceiling, or -1 without one.
   */
  zeroDrainIssueLimit?: number;
  notes?: string;
  localPath?: string;
  webhook?: ProjectWebhookRoutingSettings;
  /**
   * When true, a manual (human-triggered — `launchSource: 'ui'` or `'cli'`)
   * launch first runs `git fetch origin` + `git pull --rebase` against
   * `localPath` before the task starts, so operators never begin work
   * against a stale ambient checkout. Requires `localPath` to be set — the
   * match is by canonicalized cwd, not project id. Never applies to
   * schedule-fired or other automated launches. Defaults to false/unset.
   */
  autoSyncOnManualLaunch?: boolean;
}

/** Finite non-negative integer — used for PR rate-limit fields. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isZeroDrainIssueLimit(value: unknown): value is number {
  return value === UNLIMITED_ZERO_DRAIN_ISSUE_LIMIT || isNonNegativeInteger(value);
}

export function isAnomalySeverity(value: unknown): value is AnomalySeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

export function normalizeProjectWebhookRoutingSettings(raw: unknown): ProjectWebhookRoutingSettings | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const input = raw as Record<string, unknown>;
  const settings: ProjectWebhookRoutingSettings = {};
  if (typeof input.enabled === 'boolean') settings.enabled = input.enabled;
  if (isAnomalySeverity(input.minSeverity)) settings.minSeverity = input.minSeverity;
  return settings;
}

export function sanitizeProjectConfig(raw: unknown): ProjectConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.project !== 'string' || !input.project.trim()) return null;

  const config: ProjectConfig = { project: input.project };
  if (typeof input.tracked === 'boolean') config.tracked = input.tracked;
  // Reject Infinity/NaN/negatives/fractions (do not clamp): a bad value must not
  // override rate-limits.json. budgetWarnUsd below clamps negatives to 0 instead.
  if (isNonNegativeInteger(input.dailyPrLimit)) config.dailyPrLimit = input.dailyPrLimit;
  if (isNonNegativeInteger(input.weeklyPrLimit)) config.weeklyPrLimit = input.weeklyPrLimit;
  if (isZeroDrainIssueLimit(input.zeroDrainIssueLimit)) config.zeroDrainIssueLimit = input.zeroDrainIssueLimit;
  if (typeof input.budgetWarnUsd === 'number' && Number.isFinite(input.budgetWarnUsd)) {
    config.budgetWarnUsd = Math.max(0, input.budgetWarnUsd);
  }
  if (typeof input.notes === 'string') {
    config.notes =
      input.notes.length > MAX_PROJECT_NOTES_LENGTH
        ? input.notes.slice(0, MAX_PROJECT_NOTES_LENGTH)
        : input.notes;
  }
  if (typeof input.localPath === 'string') config.localPath = input.localPath;
  const webhook = normalizeProjectWebhookRoutingSettings(input.webhook);
  if (webhook !== undefined) config.webhook = webhook;
  if (typeof input.autoSyncOnManualLaunch === 'boolean') {
    config.autoSyncOnManualLaunch = input.autoSyncOnManualLaunch;
  }
  return config;
}
