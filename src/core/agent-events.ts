import type { CodexHookCapabilities } from './hook-events.js';

// Normalized agent events (from architecture.md, adapted from aegiscore)
export type AgentEvent = (
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
    }
) & {
  /**
   * Monotonic sequence assigned by Monitor per supervised session. Used by the
   * browser to merge overlapping windowed snapshots without collapsing
   * repeated identical hook events.
   */
  eventSeq?: number;
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
