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
export interface PersistedSnooze {
  taskId: string;
  anomaly: PersistedAnomaly;
  expiresAt: number; // ms since epoch
  reason?: string;
}
