import type { CodexHookCapabilities } from './hook-events.js';

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
      turnId?: string;
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
      hookLineId?: string;
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
  | { type: 'session_end'; sessionId: string; reason: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'input_received'; sessionId: string }
) & {
  eventSeq?: number;
};
