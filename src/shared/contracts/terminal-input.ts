export type PromptStatus =
  | { kind: 'unknown' }
  | { kind: 'ready'; readinessVersion: number }
  | {
      kind: 'blocked';
      reason: 'permission' | 'running' | 'terminated';
    };

export interface TerminalInputSnapshot {
  sessionId: string;
  taskId: string;
  inputStateEpoch: string;
  readinessVersion: number;
  promptReady: boolean;
}

export interface EmptyEnterIntentRequest {
  type: 'emptyEnterIntent';
  intentId: string;
  taskId: string;
  sessionId: string;
  selectionVersion: number;
  inputStateEpoch: string;
  observedReadinessVersion: number;
  /**
   * Routable session ids in the exact order the frontend presents them
   * (findings first, then healthy, each in `compareRoutableAgents` order).
   * The server advances to the next routable entry after `sessionId`,
   * re-validating each id against its authoritative snapshot so it never lands
   * on a task the frontend would have excluded (#1079). Omitted by older
   * clients, in which case the server derives a routable order from its own
   * snapshot.
   */
  orderedCandidateSessionIds?: string[];
}

/**
 * Bounded diagnostic context attached to an empty-Enter advancement so future
 * reports can explain why a particular next task was selected (#1079). All
 * fields are scalar — no unbounded lists — so this is cheap to log and to ship
 * over the wire on every decision.
 */
export interface EmptyEnterAdvanceDiagnostics {
  /**
   * `frontend-order` when the advancement followed an explicit ordered
   * candidate list supplied by the client; `fallback-snapshot-order` when the
   * server derived the order from its own snapshot (legacy/older clients).
   */
  source: 'frontend-order' | 'fallback-snapshot-order';
  /** Size of the ordered candidate list provided by the client (0 in fallback). */
  candidateCount: number;
  /** Number of candidates that survived server-side routability validation. */
  routableCount: number;
  /** Unique candidates dropped because they were missing or non-routable in the snapshot. */
  excludedCount: number;
  /** Whether the current session was present in the routable order. */
  currentInOrder: boolean;
  /** The session selected as next, or null when nothing routable remained. */
  selectedSessionId: string | null;
}

export type EmptyEnterRejectReason =
  | 'stale-epoch'
  | 'stale-readiness-version'
  | 'stale-selection'
  | 'not-ready'
  | 'blocked'
  | 'session-gone';

export type EmptyEnterDecision =
  | {
      kind: 'valid-empty-enter';
      intentId: string;
      taskId: string;
      sessionId: string;
      inputStateEpoch: string;
      decisionReadinessVersion: number;
    }
  | {
      kind: 'rejected';
      intentId: string;
      sessionId: string;
      reason: EmptyEnterRejectReason;
    };
