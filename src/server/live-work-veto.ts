import type { Task } from '../core/tasks.js';
import { taskHasLiveTurn } from '../core/finished-awaiting-ack-ttl.js';
import { paneHasHumanInteractiveMarkers } from '../shared/pane-semantics.js';

/**
 * Single owner of the "is a human actively here right now?" veto shared by
 * every background path that force-completes / auto-closes a task holding a
 * `completion_ready` signal.
 *
 * Why this exists: the `completion_ready` signal is a task-level flag that is
 * NOT cleared when the agent starts a new turn, and the auto-close selectors
 * are deliberately age-only. Between selection and teardown a quiet task can
 * have its turn resumed, a human can be mid-keystroke in the composer, or an
 * operator can simply have the terminal attached. The finished-awaiting-ack
 * TTL/ack reapers learned this the hard way (issues #2170 / #2238 / #3040) and
 * grew a TOCTOU re-GET + liveness veto. The older completion-ready-ttl drain
 * valve (issue #1526 FM5) never got it, so it tore down a live session whose
 * human was typing an unsent message. Centralising the veto here keeps the two
 * populations — they are the same `completion_ready` population — guarded by
 * ONE definition, so a future sibling sweep cannot silently skip it.
 *
 * This decides the veto only; callers own the re-GET, logging, metrics and the
 * `completeTask` call. Each signal is checked independently and the first match
 * wins, purely so the returned `reason` is stable for logs/tests.
 */
export type LiveWorkVetoReason =
  /** A non-terminal session reports a running / waiting-for-input / blocked turn. */
  | 'live_turn'
  /** The live pane shows a high-confidence human input prompt or permission dialog. */
  | 'interactive_pane'
  /** A viewer connection currently has the task selected/attached. */
  | 'viewer_present'
  /** The task is holding a confirmed-open delivery PR that a close would strand. */
  | 'open_pr';

export type LiveWorkVetoResult =
  | { veto: true; reason: LiveWorkVetoReason }
  | { veto: false };

export interface LiveWorkSignals {
  /** Latest reconstructed pane text for the task's live session, if available. */
  paneText?: string | undefined | null;
  /** True when a viewer connection currently has this task selected/attached. */
  present?: boolean;
  /**
   * PR-hold result for the task. Only a definite `true` (confirmed-open PR)
   * vetoes — `false`/`undefined` (no PR, or unknown ref) do not, matching the
   * ack-path reaper's fail-safe contract.
   */
  holdingOpenPr?: boolean | undefined;
}

/**
 * Human-readable deferral reason for operator-facing warn logs.
 */
export function liveWorkVetoReasonText(reason: LiveWorkVetoReason): string {
  switch (reason) {
    case 'live_turn':
      return 'turn resumed (live turn) since selection';
    case 'interactive_pane':
      return 'pane shows a human-interactive prompt';
    case 'viewer_present':
      return 'a viewer has the task attached';
    case 'open_pr':
      return 'confirmed-open PR hold landed since selection';
  }
}

/**
 * Return a veto when any live-human signal is present for a (freshly re-read)
 * task, else `{ veto: false }`. Pass the already-fetched fresh task — this does
 * not read the store.
 */
export function evaluateLiveWorkVeto(
  task: Pick<Task, 'sessions'>,
  signals: LiveWorkSignals = {},
): LiveWorkVetoResult {
  if (taskHasLiveTurn(task)) return { veto: true, reason: 'live_turn' };
  if (paneHasHumanInteractiveMarkers(signals.paneText)) {
    return { veto: true, reason: 'interactive_pane' };
  }
  if (signals.present === true) return { veto: true, reason: 'viewer_present' };
  if (signals.holdingOpenPr === true) return { veto: true, reason: 'open_pr' };
  return { veto: false };
}
