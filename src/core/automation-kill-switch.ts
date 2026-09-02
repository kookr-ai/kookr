/**
 * Global automation kill-switch + SAFE MODE surfaces (issue #1710 / #1699 WS0.4)
 * and the per-project automation pause conjunction in front of them.
 *
 * When SAFE MODE is engaged, autonomous actuation (schedule fires and
 * schedule-sourced launches) is halted. Manual launches (API / UI / CLI /
 * websocket / remote) remain accepted — distinct from drain mode (#659), which
 * refuses *all* new launches.
 *
 * A per-project pause is the same question with a project id: autonomous
 * launches for that project halt while other projects keep firing. It does
 * not flip `schedule.enabled`.
 */

import type { TaskLaunchSource } from '../shared/contracts/task.js';

/** Empty paused-id set reused by callers that omit a live getter. */
export const EMPTY_PAUSED_PROJECT_IDS: ReadonlySet<string> = new Set();

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
 * Schedule fires, the idle-slot idea refinery (issue #2144), and post-recovery
 * queue fill (issue #2899) are the first-class autonomous spawn paths; other
 * sources (api/ui/cli/websocket/remote) are operator- or human-driven and stay
 * accepted in SAFE MODE.
 */
export function isAutonomousLaunchSource(
  launchSource: TaskLaunchSource | undefined,
): boolean {
  return launchSource === 'schedule'
    || launchSource === 'idle-refinery'
    || launchSource === 'post-recovery';
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
 * Daily reflection playbook whose cwd is typically `~/.claude` / dotclaude.
 * Pause identity follows kb-scout-evol, not the cwd's git remote.
 */
const KB_SCOUT_REFLECTION_PLAYBOOK_BASENAME = 'kb-scout-reflection.md';
const KB_SCOUT_EVOL_PROJECT_ID = 'github.com/jeanibarz/kb-scout-evol';

/** Playbook-file basename without a `node:path` import (this module is layer-shared). */
export function playbookFileBasename(playbookPath?: string | null): string {
  const path = playbookPath?.toLowerCase() ?? '';
  return path.split(/[/\\]/).pop() ?? '';
}

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
  return playbookFileBasename(input.playbookPath) === CROSS_REPO_ORCHESTRATOR_PLAYBOOK_BASENAME;
}

/**
 * Resolve the project id a schedule fire is gated on.
 *
 * `kb-scout-reflection.md` maps to kb-scout-evol even when the schedule cwd is
 * `~/.claude`. Everything else uses `cwdProjectId` from `getProjectId(cwd)`.
 * The queue-feeder is *not* remapped — it is Lucy slot work and pauses with Lucy.
 */
export function resolveScheduleAutomationProjectId(input: {
  playbookPath?: string | null;
  cwdProjectId: string;
}): string {
  if (playbookFileBasename(input.playbookPath) === KB_SCOUT_REFLECTION_PLAYBOOK_BASENAME) {
    return KB_SCOUT_EVOL_PROJECT_ID;
  }
  return input.cwdProjectId;
}

export type AutonomousActuationDecision =
  | 'allow'
  | 'safe_mode'
  | 'project_paused'
  | 'not_autonomous';

/**
 * Single owner of "may this autonomous fire run?"
 *
 * Polarity lives here: global SAFE MODE is `globalEnabled === false` (unless
 * `safeModeExempt`, which bypasses *only* the global lever). A project pause
 * is Set membership of `projectId`. Callers must not re-implement `!== false`.
 *
 * A missing / unknown `projectId` is a Set miss → do not skip for the project
 * lever (the launch-service stamp check is a separate programming-error gate).
 */
export function mayAutonomousActuate(input: {
  source: TaskLaunchSource | undefined;
  projectId: string | undefined;
  globalEnabled: boolean;
  pausedProjectIds: ReadonlySet<string>;
  safeModeExempt?: boolean;
}): AutonomousActuationDecision {
  if (!isAutonomousLaunchSource(input.source)) return 'not_autonomous';
  if (!input.globalEnabled && !input.safeModeExempt) return 'safe_mode';
  if (input.projectId && input.pausedProjectIds.has(input.projectId)) {
    return 'project_paused';
  }
  return 'allow';
}

/** Snapshot of projects whose agent automation is paused. Distinct from SAFE MODE. */
export interface ProjectAutomationStatus {
  paused: Array<{ projectId: string; since?: string }>;
  /** Whole-file project-config quarantine warning; fail-open, not a second SAFE MODE. */
  loadWarning?: string;
}

/** Operator-facing one-liner for health / status / ops-digest. Null when nothing is paused. */
export function formatProjectAutomationDigestLine(
  status: ProjectAutomationStatus,
): string | null {
  const ids = status.paused.map((row) => row.projectId);
  if (ids.length === 0 && !status.loadWarning) return null;
  const pausedPart = ids.length === 0
    ? null
    : `project automation paused: ${ids.join(', ')}`;
  if (!status.loadWarning) return pausedPart;
  const detail = status.loadWarning.length > 120
    ? `${status.loadWarning.slice(0, 117)}...`
    : status.loadWarning;
  if (!pausedPart) {
    return `project-config load warning: ${detail}`;
  }
  return `${pausedPart} (project-config load warning: ${detail})`;
}

/**
 * Stamp `automationPausedSince` on the true→false edge, clear it on
 * false→true, preserve it on unrelated saves. Sanitize is prev-blind; the
 * store is the only place that sees both.
 */
export function applyProjectAutomationTransition<T extends {
  automationEnabled?: boolean;
  automationPausedSince?: string;
}>(
  prev: Pick<T, 'automationEnabled' | 'automationPausedSince'>,
  next: T,
  nowIso: string,
): T {
  const wasPaused = prev.automationEnabled === false;
  const isPaused = next.automationEnabled === false;

  if (!isPaused) {
    if (next.automationPausedSince === undefined && !wasPaused) return next;
    const { automationPausedSince: _drop, ...rest } = next;
    return rest as T;
  }

  const since =
    wasPaused && prev.automationPausedSince
      ? prev.automationPausedSince
      : (next.automationPausedSince ?? nowIso);

  if (next.automationPausedSince === since) return next;
  return { ...next, automationPausedSince: since };
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
