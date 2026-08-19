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
  /**
   * When set, kill-switch state could not be trusted from disk (corrupt or
   * unreadable settings). Autonomous launches fail closed until settings
   * recover (issue #2085). Manual launches remain accepted.
   */
  loadError?: string;
}

/**
 * Launch sources that count as autonomous actuation for the kill-switch.
 * Schedule fires and the idle-slot idea refinery (issue #2144) are the
 * first-class autonomous spawn paths; other sources (api/ui/cli/websocket/
 * remote) are operator- or human-driven and stay accepted in SAFE MODE.
 */
export function isAutonomousLaunchSource(
  launchSource: TaskLaunchSource | undefined,
): boolean {
  return launchSource === 'schedule' || launchSource === 'idle-refinery';
}

/**
 * Playbook-file basename identifying the cross-repo orchestrator schedule
 * (issue #2672). This one schedule must keep ticking during SAFE MODE so the
 * fleet can auto-resume after a quota window resets: it snapshots, honors the
 * pause, and spawns nothing. Deliberately narrow — the
 * `*-orchestration-supervisor` schedules and every other autonomous schedule
 * (queue-feeder, Parallel Issue Batch, idea-scout, merge-watchdog) stay gated.
 */
const CROSS_REPO_ORCHESTRATOR_PLAYBOOK_BASENAME = 'cross-repo-orchestrator.md';

/**
 * Is this schedule exempt from the SAFE-MODE pre-fire gate? Only the cross-repo
 * orchestrator schedule is, matched by an EXACT playbook-file basename (the
 * operator-chosen schedule name is deliberately not consulted — it is not
 * authoritative). An exact basename keeps the match narrow: a look-alike path
 * like `cross-repo-orchestrator-backup.md` does NOT get exempted. See
 * {@link CROSS_REPO_ORCHESTRATOR_PLAYBOOK_BASENAME}.
 *
 * Exemption is scoped to *letting the schedule fire and the orchestrator agent
 * launch*; the orchestrator playbook itself still refuses to spawn children
 * while paused.
 */
export function isSafeModeExemptSchedule(input: {
  playbookPath?: string | null;
}): boolean {
  const path = input.playbookPath?.toLowerCase() ?? '';
  // Basename without a node:path import (this module is layer-shared): take the
  // segment after the last '/' or '\'.
  const basename = path.split(/[/\\]/).pop() ?? '';
  return basename === CROSS_REPO_ORCHESTRATOR_PLAYBOOK_BASENAME;
}

/** Build the live SAFE MODE status from settings (or equivalent booleans). */
export function resolveSafeModeStatus(input: {
  automationKillSwitch: boolean;
  safeModeSince: string | null | undefined;
  /** Settings load failure — forces engaged + surfaces on health (issue #2085). */
  loadError?: string | null;
}): SafeModeStatus {
  const loadError =
    typeof input.loadError === 'string' && input.loadError.trim().length > 0
      ? input.loadError.trim()
      : undefined;

  // Unknown kill-switch state fails closed: treat as engaged until recovered.
  if (loadError || input.automationKillSwitch) {
    const since =
      typeof input.safeModeSince === 'string' && input.safeModeSince.length > 0
        ? input.safeModeSince
        : undefined;
    return {
      engaged: true,
      ...(since ? { since } : {}),
      ...(loadError ? { loadError } : {}),
    };
  }

  return { engaged: false };
}

/**
 * Operator-facing one-liner for health digests / status CLI.
 * Returns null when SAFE MODE is not engaged.
 */
export function formatSafeModeDigestLine(status: SafeModeStatus): string | null {
  if (!status.engaged) return null;
  const base = status.since
    ? `SAFE MODE since ${status.since}`
    : 'SAFE MODE';
  if (!status.loadError) return base;
  // Keep the digest one line; truncate long load errors for status CLIs.
  const detail = status.loadError.length > 120
    ? `${status.loadError.slice(0, 117)}...`
    : status.loadError;
  return `${base} (settings load error: ${detail})`;
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
