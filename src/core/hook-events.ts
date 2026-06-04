import type { AgentType } from './agent-types.js';

// Hook event names from Claude Code hooks (PoC 001 + PoC 002 + PoC 003)
export type HookEventName =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'StopFailure'
  | 'PermissionRequest'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'SessionEnd';

export interface CodexHookHandlerFeatures {
  commandIf?: boolean;
}

export interface CodexHookCapabilities {
  surfaceVersion: number;
  supportedEvents: HookEventName[];
  handlerFeatures?: CodexHookHandlerFeatures;
}

// Base hook event payload (raw from stdin)
export interface HookEventBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: HookEventName;
}

/**
 * Parentage classification for a hook record, relative to the Kookr terminal
 * session that owns the hook file. See rfc-activity-log-reliability.
 */
export type EventParentage = 'parent' | 'child' | 'foreign' | 'unknown';

/**
 * Whether a hook record came from a live agent session or was replayed into
 * Kookr by a developer tool (e.g. `scripts/replay-hooks.ts`) to reproduce
 * detector behavior locally. Replayed records are always scoped to a dedicated
 * synthetic session, so they can never be mistaken for fresh output on a live
 * session — which would otherwise clear safety UI too early. Surfaced on
 * {@link InjectHookEventResult}; defaults to `'live'` when unset. See issue
 * #701 and KB lesson `distinguish-replayed-events-from-fresh-events`.
 */
export type EventOrigin = 'live' | 'replay';

/**
 * Outer metadata attached to every parsed hook event as it travels through
 * the ingestion pipeline.
 */
export interface EventMeta {
  parentage: EventParentage;
  /** Provider session id from the raw payload (`session_id`). */
  rawSessionId?: string;
  /** Kookr-assigned monotonic sequence number per kookrSessionId. */
  sequence: number;
  /** ms since epoch when Kookr observed the record. */
  observedAt: number;
}

/**
 * Aggregate counters published on each AgentState so the activity panel can
 * disclose partial-window state and child / malformed counts without
 * re-reading the durable ledger on every snapshot tick.
 */
export interface AgentActivityMeta {
  /** Distinct hook records observed (dedup-aware: duplicates do not double-count). */
  totalEventsSeen: number;
  parentEventCount: number;
  childEventCount: number;
  foreignEventCount: number;
  unknownParentageCount: number;
  malformedRecordCount: number;
  droppedRecordCount: number;
  duplicateRecordCount: number;
}

/**
 * Outcome of a single hook record injection. Adapters must return a result for
 * every call, including parse failures and unknown hook event names.
 */
export interface InjectHookEventResult {
  parseStatus: 'ok' | 'malformed' | 'dropped';
  /** Provider session id from the raw payload. Present for ok / dropped; may
   *  be missing for malformed. */
  rawSessionId?: string;
  rawTurnId?: string;
  rawHookEventName?: string;
  /** Classified parentage relative to the Kookr terminal session. */
  parentage?: EventParentage;
  /** Sequence number used in EventMeta for this record, when ok. */
  sequence?: number;
  /** Adapter type that handled the inject. */
  agentType: AgentType;
  /** Free-text reason when parseStatus !== 'ok'. */
  error?: string;
  /**
   * Whether this record was injected from a live session or replayed for
   * local reproduction. Set by {@link HookIngestion} from the session id and
   * surfaced so callers/tests can confirm replayed records are tagged
   * `'replay'`, never `'live'`. Defaults to `'live'` when unset.
   */
  origin?: EventOrigin;
}
