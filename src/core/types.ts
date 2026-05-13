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

// Normalized agent events (from architecture.md, adapted from aegiscore)
export type AgentEvent =
  | {
      type: 'session_start';
      sessionId: string;
      transcriptPath?: string;
      model?: string;
      cwd?: string;
      codexHookCapabilities?: CodexHookCapabilities;
    }
  | {
      type: 'tool_use';
      sessionId: string;
      toolName: string;
      toolInput?: unknown;
      toolUseId?: string;
      cwd?: string;
    }
  | {
      type: 'tool_result';
      sessionId: string;
      toolName: string;
      toolResponse?: unknown;
      toolUseId?: string;
      cwd?: string;
    }
  | {
      type: 'tool_error';
      sessionId: string;
      toolName: string;
      toolInput?: unknown;
      toolUseId?: string;
      error: string;
      isInterrupt: boolean;
      cwd?: string;
    }
  | {
      type: 'subagent_start';
      sessionId: string;
      agentId: string;
      agentType: string;
      cwd?: string;
    }
  | {
      type: 'subagent_stop';
      sessionId: string;
      agentId: string;
      agentType: string;
      lastMessage: string;
      agentTranscriptPath?: string;
      cwd?: string;
    }
  | {
      type: 'stop';
      sessionId: string;
      lastMessage: string;
      cwd?: string;
      transcriptPath?: string;
      /** Stable per-turn identifier injected by the Stop hook. When present, used for dedup fingerprinting. */
      turnId?: string;
      /** Sequential line number within the hook file. Used to distinguish multiple Stops in one long turn. */
      hookLineId?: string;
    }
  | {
      type: 'permission_request';
      sessionId: string;
      toolName: string;
      toolInput?: unknown;
      suggestions?: unknown[];
      cwd?: string;
    }
  | {
      type: 'notification';
      sessionId: string;
      notificationType: string;
      message: string;
      cwd?: string;
    }
  | {
      type: 'user_prompt';
      sessionId: string;
      prompt: string;
      cwd?: string;
    }
  | {
      type: 'stop_failure';
      sessionId: string;
      error: string;
      lastMessage: string;
      cwd?: string;
      transcriptPath?: string;
      turnId?: string;
      hookLineId?: string;
    }
  | {
      type: 'session_end';
      sessionId: string;
      reason: string;
    }
  | {
      type: 'error';
      sessionId: string;
      message: string;
    }
  | {
      type: 'input_received';
      sessionId: string;
    };

/**
 * Parentage classification for a hook record, relative to the Kookr terminal
 * session that owns the hook file. See rfc-activity-log-reliability §3.
 *
 * - `parent`  : provider session_id matches the parent runtime session for this Kookr session.
 * - `child`   : provider session_id is a different one, recorded as a child of the parent.
 * - `foreign` : provider session_id maps to another active Kookr session/task. (Reserved — Phase 3.)
 * - `unknown` : session_id missing, or parent has not yet been established.
 */
export type EventParentage = 'parent' | 'child' | 'foreign' | 'unknown';

/**
 * Outer metadata attached to every parsed hook event as it travels through
 * the ingestion pipeline. Kept separate from {@link AgentEvent} so the
 * normalized event type remains provider-agnostic. Phase 1 in-memory shape;
 * Phase 3 persists a richer {@link HookEnvelopeV1} ledger row.
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
 * Per-Kookr-session record of which provider runtime session owns the hook
 * file (parent) and which other session ids have appeared on the same file
 * (children). Frozen-after-first-set semantics: the parent is the first
 * SessionStart for the Kookr session; later distinct session_ids are recorded
 * as children, never overwriting the parent.
 */
export interface ChildSessionInfo {
  firstSeenAt: string;
  transcriptPath?: string;
  reason: 'subagent_hook' | 'inherited_settings' | 'unknown';
}

// Type guards for AgentEvent discriminated union
export function isSessionStartEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'session_start' }> {
  return event.type === 'session_start';
}

export function isToolUseEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'tool_use' }> {
  return event.type === 'tool_use';
}

export function isToolResultEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'tool_result' }> {
  return event.type === 'tool_result';
}

export function isStopEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'stop' }> {
  return event.type === 'stop';
}

export function isPermissionRequestEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'permission_request' }> {
  return event.type === 'permission_request';
}

export function isErrorEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'error' }> {
  return event.type === 'error';
}

// Per-task token usage aggregation
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

// Git repository metadata (moved from adapters/git-info.ts to fix core→adapters dependency)
export interface GitInfo {
  branch: string | null;
  commit: string | null;
  isWorktree: boolean;
  isDetached: boolean;
}

export type WorktreeHealth =
  | 'ok'
  | 'stale'
  /** Legacy value retained for persisted tasks from older builds. New unexpected misses use `missing_unexpectedly`. */
  | 'missing'
  | 'missing_unexpectedly'
  | 'cleaned_up';

// Agent status — used as metadata on persisted sessions (SessionInfo.lastStatus),
// not as a live state machine. See architecture.md for details.
export type AgentStatus =
  | 'starting'
  | 'running'
  | 'stuck'
  | 'errored'
  | 'completed'
  | 'snoozed';

// Task lifecycle (from features.md F4.4)
// 'terminated' added by rfc-task-loss-prevention: session died without user ack.
// Distinct from 'completed', which now means user-acknowledged done.
export type TaskStatus =
  | 'open'
  | 'pending'
  | 'inProgress'
  | 'completed'
  | 'terminated'
  | 'cancelled';

// Anomaly detection output
export type AnomalyType =
  | 'needs_input'
  | 'permission_blocked'
  | 'repeated_error'
  | 'merge_conflict'
  | 'stale_agent'
  | 'hook_disconnected'
  | 'hook_missing'
  | 'tmux_unresponsive'
  | 'api_error'
  | 'auto_proceed_failure'
  | 'budget_exceeded';

export type AnomalySeverity = 'info' | 'warning' | 'critical';

/**
 * Confidence level for shadow-detection verdicts. Only used by shadow strategies —
 * the real detector's anomalies are implicitly high-confidence.
 */
export type AnomalyConfidence = 'high' | 'medium' | 'low';

export interface Anomaly {
  agentId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
  detectedAt: Date;
  count?: number;
  /** Discriminates needs_input sub-types for autonomy decisions. */
  subType?: 'stop' | 'ask_user_question';
  /** ISO timestamp when auto-proceed will fire. Set by broadcast layer, not stored in core. */
  autoProceedingAt?: string;
  /** Shadow-only: strategy confidence for offline precision analysis. */
  confidence?: AnomalyConfidence;
}

/** Serialized anomaly for persistence — detectedAt is ISO string, not Date. */
export interface PersistedAnomaly {
  agentId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
  detectedAt: string;
  count?: number;
  subType?: 'stop' | 'ask_user_question';
}

/** Persisted snooze state — stored in the task file envelope. */
export interface LegacyPersistedSnooze {
  taskId: string;
  anomaly: PersistedAnomaly;
  expiresAt: number; // ms since epoch
  reason?: string;
}

export interface PersistedSnooze {
  taskId: string;
  agentId?: string;
  kind: 'finding' | 'task';
  anomaly?: PersistedAnomaly;
  expiresAt: number; // ms since epoch
  createdAt: number; // ms since epoch
  expiredPendingRestore?: boolean;
  reason?: string;
}
