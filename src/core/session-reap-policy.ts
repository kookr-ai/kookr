import { isTerminalStatus } from '../shared/contracts/task-status.js';
import type { TaskStatus } from '../shared/contracts/task-status.js';

/**
 * Pure decision logic for the orphan/terminal-task session reaper (issue
 * #1720). On 2026-07-30, 41 orphan dtach sessions accumulated over ~a week —
 * reconciliation already computes the orphan set (the "Orphan sessions (not
 * in tasks):" startup log line) but nothing ever reaped it, so leaked
 * grok/claude/codex process trees held ~5.5 GB RSS+swap until the kernel OOM
 * killer took out the prod server. The 2026-07-30 follow-up audit
 * (issue comment) found a SECOND leak class beyond true orphans: a task can
 * reach a terminal status (`completed`/`terminated`/`cancelled`) while its
 * session's dtach master + agent process are still resident — e.g.
 * `kookr-826a3ebe` mapped to a `completed` task yet its codex process was
 * alive 1d16h later. That happens when the normal fire-and-forget
 * `adapter.stop()` call in `agent-lifecycle.ts`'s `completeTask`/
 * `terminateTask` silently fails (logged with only a `console.warn`, no
 * retry) — this module is the safety-net sweep that catches both classes.
 *
 * This module contains NO I/O — it only classifies an already-observed live
 * session against already-observed task/session state. All disk reads
 * (dtach manifest `startedAt`), backend calls (`killSession`), and audit
 * logging live in `server/session-reaper.ts`, which calls this module's pure
 * functions to decide what to do.
 */

/** Ownership of a live (backend-reported) dtach session, as seen by the TaskStore. */
export type SessionOwnership =
  /** No task references this session id at all — a true orphan (leak class 1). */
  | { kind: 'unowned' }
  /** A task references this session id. */
  | {
      kind: 'owned';
      taskId: string;
      taskStatus: TaskStatus;
      /** `SessionInfo.lastStatus` for this session record. */
      sessionLastStatus: string | undefined;
    };

/** What kind of session this is, independent of whether reaping is currently enabled. */
export type SessionReapKind =
  /** Owned by a task that is not yet terminal — never touched by this sweep. */
  | 'active'
  /** No owning task at all (leak class 1 — the original orphan report). */
  | 'unowned'
  /**
   * Owned by a task whose status is already terminal, or whose session record
   * already carries a terminal `lastStatus` — the task moved on but the
   * session process tree is still resident (leak class 2, issue #1720
   * follow-up comment).
   */
  | 'terminal-task-leak';

export interface SessionReapConfig {
  /** Master kill-switch. Default true (`KOOKR_REAP_ORPHAN_SESSIONS`). */
  enabled: boolean;
  /**
   * Minimum age (ms) an UNOWNED session must have before it is reaped, so the
   * sweep never races a mid-launch session (#1537 item 2: a launch-abort leak
   * "leaks until reconciliation *reports* (not kills) it as an orphan").
   * Default 24h.
   */
  orphanAgeThresholdMs: number;
  /**
   * Minimum time (ms) a TERMINAL-TASK session must have been observably
   * terminal before it is reaped. Deliberately much shorter than
   * `orphanAgeThresholdMs`: the owning task/session record is already known to
   * be done, so there is no "is this a fresh launch" ambiguity — the grace
   * period only exists to avoid double-signalling a session that
   * `completeTask`'s own fire-and-forget `adapter.stop()` is still in the
   * middle of stopping (that racing call is harmless — `killSession` is
   * idempotent — but a short grace keeps normal-path completions from ever
   * showing up in the audit log as system-reaper actions). Default 60s.
   */
  terminalTaskGraceMs: number;
}

export interface SessionReapDecision {
  sessionId: string;
  kind: SessionReapKind;
  /** ms since the backend reports this session started, or null when unknown. */
  ageMs: number | null;
  shouldReap: boolean;
  /** Human-readable justification, for audit logging. */
  reason: string;
}

const OWNED_TERMINAL_SESSION_STATUSES = new Set(['completed', 'aborted']);

/** Classify a session's ownership into a reap-relevant kind (pure, no I/O). */
export function classifySessionReapKind(ownership: SessionOwnership): SessionReapKind {
  if (ownership.kind === 'unowned') return 'unowned';
  if (
    isTerminalStatus(ownership.taskStatus)
    || (ownership.sessionLastStatus !== undefined
      && OWNED_TERMINAL_SESSION_STATUSES.has(ownership.sessionLastStatus))
  ) {
    return 'terminal-task-leak';
  }
  return 'active';
}

/**
 * Decide whether a single live session should be reaped right now.
 *
 * `startedAtMs` is the backend-reported session start time (dtach manifest
 * `startedAt`), or `null` when the backend cannot report it — an unknown age
 * is treated conservatively as "not yet eligible" rather than either extreme,
 * matching the codebase's existing "unreadable path defaults to false"
 * convention (see `reconciliation.ts`'s `defaultPathExists`).
 */
export function decideSessionReap(
  sessionId: string,
  ownership: SessionOwnership,
  startedAtMs: number | null,
  now: number,
  config: SessionReapConfig,
): SessionReapDecision {
  const kind = classifySessionReapKind(ownership);
  const ageMs = startedAtMs !== null ? Math.max(0, now - startedAtMs) : null;

  if (kind === 'active') {
    return {
      sessionId,
      kind,
      ageMs,
      shouldReap: false,
      reason: 'session belongs to a non-terminal task',
    };
  }

  if (!config.enabled) {
    return {
      sessionId,
      kind,
      ageMs,
      shouldReap: false,
      reason: 'reaping disabled (KOOKR_REAP_ORPHAN_SESSIONS=false)',
    };
  }

  const thresholdMs = kind === 'unowned' ? config.orphanAgeThresholdMs : config.terminalTaskGraceMs;

  if (ageMs === null) {
    return {
      sessionId,
      kind,
      ageMs,
      shouldReap: false,
      reason: 'session age unknown; skipping to avoid racing a mid-launch session',
    };
  }

  if (ageMs < thresholdMs) {
    return {
      sessionId,
      kind,
      ageMs,
      shouldReap: false,
      reason: `${kind} session is ${ageMs}ms old, below the ${thresholdMs}ms threshold`,
    };
  }

  return {
    sessionId,
    kind,
    ageMs,
    shouldReap: true,
    reason: `${kind} session exceeds the ${thresholdMs}ms threshold (age ${ageMs}ms)`,
  };
}
