/**
 * Transition emitter for status-style monitors (issue #1716, complements #1709).
 *
 * Monitors like deploy-lag and prod-smoke already compute a status (`ok` /
 * `alert`). What was missing is a *transition sink*: turning an ok→alert or
 * alert→ok edge into an operator signal. This module is pure edge-detection —
 * given the previous and current status it returns the signal to emit (or
 * null when nothing changed), so it is trivially testable and reusable by any
 * monitor.
 *
 * Both edges fire: ok→alert emits an `alert` signal, alert→ok emits a `clear`
 * signal (fire AND clear). The `unknown` status (e.g. a probe that could not
 * run) never emits on its own — it only records so the next real edge is
 * detected against the last *known* status.
 */

import type { OperatorSignalKind } from './operator-signal.js';

export type MonitorStatus = 'ok' | 'alert' | 'unknown';

export interface TransitionInput {
  /** Logical monitor name, e.g. `deploy-lag`, `prod-smoke`. Used in the signal key/source. */
  source: string;
  /** Last known status (from persisted state); `unknown` on first ever run. */
  prev: MonitorStatus;
  /** Current status computed by the monitor this run. */
  curr: MonitorStatus;
  /** Human summary for the notification (e.g. "7 commits / 9.5h behind origin/main"). */
  detail?: string;
}

export interface TransitionSignal {
  key: string;
  kind: OperatorSignalKind;
  source: string;
  title: string;
  detail?: string;
}

export interface TransitionResult {
  /** The signal to emit, or null when the edge does not warrant one. */
  signal: TransitionSignal | null;
  /**
   * The status to persist as the new "prev". Equals `curr` except that an
   * `unknown` current status leaves the last *known* status intact so an
   * intermittent probe failure does not manufacture a spurious clear later.
   */
  nextPrev: MonitorStatus;
}

/**
 * Detect a status transition and, when it crosses the ok/alert boundary,
 * produce the signal to emit. Pure: callers own persistence of `nextPrev`.
 */
export function detectTransition(input: TransitionInput): TransitionResult {
  const { source, prev, curr, detail } = input;

  // An unknown reading never emits and never overwrites the last known status.
  if (curr === 'unknown') {
    return { signal: null, nextPrev: prev };
  }

  // First real reading, or unchanged status: record, do not emit.
  if (prev === curr || prev === 'unknown') {
    return { signal: null, nextPrev: curr };
  }

  if (prev === 'ok' && curr === 'alert') {
    return {
      signal: {
        key: `${source}:alert`,
        kind: 'alert',
        source,
        title: `${source} entered ALERT`,
        ...(detail !== undefined ? { detail } : {}),
      },
      nextPrev: 'alert',
    };
  }

  // prev === 'alert' && curr === 'ok'
  return {
    signal: {
      key: `${source}:clear`,
      kind: 'clear',
      source,
      title: `${source} recovered (alert cleared)`,
      ...(detail !== undefined ? { detail } : {}),
    },
    nextPrev: 'ok',
  };
}
