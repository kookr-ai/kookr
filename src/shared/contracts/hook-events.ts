import type { AgentType } from './agent-types.js';

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

export interface HookEventBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: HookEventName;
}

export type EventParentage = 'parent' | 'child' | 'foreign' | 'unknown';

export interface EventMeta {
  parentage: EventParentage;
  rawSessionId?: string;
  sequence: number;
  observedAt: number;
}

export interface AgentActivityMeta {
  totalEventsSeen: number;
  parentEventCount: number;
  childEventCount: number;
  foreignEventCount: number;
  unknownParentageCount: number;
  malformedRecordCount: number;
  droppedRecordCount: number;
  duplicateRecordCount: number;
}

export interface InjectHookEventResult {
  parseStatus: 'ok' | 'malformed' | 'dropped';
  rawSessionId?: string;
  rawTurnId?: string;
  rawHookEventName?: string;
  parentage?: EventParentage;
  sequence?: number;
  agentType: AgentType;
  error?: string;
}
