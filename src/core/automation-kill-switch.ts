/**
 * Global automation kill-switch + SAFE MODE surfaces (issue #1710 / #1699 WS0.4).
 *
 * When engaged, autonomous actuation (schedule fires and schedule-sourced
 * launches) is halted. Manual launches (API / UI / CLI / websocket / remote)
 * remain accepted — distinct from drain mode (#659), which refuses *all* new
 * launches.
 */

import type { TaskLaunchSource } from '../shared/contracts/task.js';

/** Snapshot shape shared by `/api/health`, WS snapshot, and the status digest. */
export interface SafeModeStatus {
  /** True while the kill-switch is engaged. */
  engaged: boolean;
  /** ISO timestamp the current SAFE MODE period began; absent while disengaged. */
  since?: string;
}

/**
 * Launch sources that count as autonomous actuation for the kill-switch.
 * Schedule fires are the only first-class autonomous spawn path today; other
 * sources (api/ui/cli/websocket/remote) are operator- or human-driven.
 */
export function isAutonomousLaunchSource(
  launchSource: TaskLaunchSource | undefined,
): boolean {
  return launchSource === 'schedule';
}

/** Build the live SAFE MODE status from settings (or equivalent booleans). */
export function resolveSafeModeStatus(input: {
  automationKillSwitch: boolean;
  safeModeSince: string | null | undefined;
}): SafeModeStatus {
  if (!input.automationKillSwitch) {
    return { engaged: false };
  }
  const since =
    typeof input.safeModeSince === 'string' && input.safeModeSince.length > 0
      ? input.safeModeSince
      : undefined;
  return since ? { engaged: true, since } : { engaged: true };
}

/**
 * Operator-facing one-liner for health digests / status CLI.
 * Returns null when SAFE MODE is not engaged.
 */
export function formatSafeModeDigestLine(status: SafeModeStatus): string | null {
  if (!status.engaged) return null;
  return status.since
    ? `SAFE MODE since ${status.since}`
    : 'SAFE MODE';
}

/**
 * Apply kill-switch engagement bookkeeping on a settings update.
 *
 * - Engaging (false→true, or true without a since): set `safeModeSince` to
 *   the previous since when already engaged, else `nowIso`.
 * - Disengaging: clear `safeModeSince`.
 * - Unrelated saves while engaged: preserve the existing since (never reset).
 */
export function applyKillSwitchTransition<T extends {
  automationKillSwitch: boolean;
  safeModeSince: string | null;
}>(
  prev: Pick<T, 'automationKillSwitch' | 'safeModeSince'>,
  next: T,
  nowIso: string,
): T {
  if (!next.automationKillSwitch) {
    if (next.safeModeSince === null && !prev.automationKillSwitch) {
      return next;
    }
    return { ...next, automationKillSwitch: false, safeModeSince: null };
  }

  const since =
    prev.automationKillSwitch && prev.safeModeSince
      ? prev.safeModeSince
      : (next.safeModeSince ?? nowIso);

  if (
    next.automationKillSwitch === true
    && next.safeModeSince === since
  ) {
    return next;
  }

  return { ...next, automationKillSwitch: true, safeModeSince: since };
}
