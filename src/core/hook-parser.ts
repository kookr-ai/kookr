import type { AgentEvent, CodexHookCapabilities, HookEventName } from './types.js';

export class HookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookParseError';
  }
}

interface RawHookPayload {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: string;
  // SessionStart fields
  model?: string;
  source?: string;
  codex_hook_capabilities?: RawCodexHookCapabilities;
  // Tool fields (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest)
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  // PostToolUse fields
  tool_response?: unknown;
  // PostToolUseFailure fields
  error?: string;
  is_interrupt?: boolean;
  // Stop fields
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  // PermissionRequest fields
  permission_suggestions?: unknown[];
  permission_mode?: string;
  // Notification fields
  notification_type?: string;
  message?: string;
  // UserPromptSubmit fields
  prompt?: string;
  // SessionEnd fields
  reason?: string;
  // Subagent fields
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}

interface RawCodexHookCapabilities {
  surface_version?: number;
  supported_events?: string[];
  handler_features?: {
    command_if?: boolean;
  };
}

const KNOWN_HOOK_EVENTS: Set<string> = new Set([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'PermissionRequest',
  'Notification',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
]);

/**
 * Header-only inspector for activity-ledger envelopes. Pulls `session_id`,
 * `turn_id`, and `hook_event_name` without enforcing them to be a known
 * event type. Throws {@link HookParseError} on malformed JSON. Used by
 * HookIngestion to populate {@link HookEnvelopeV1} fields even when the
 * payload's hook_event_name is unknown to Kookr.
 */
export interface RawHookHeader {
  rawSessionId?: string;
  rawTurnId?: string;
  rawHookEventName?: string;
}

export function extractRawHookHeader(raw: string): RawHookHeader {
  let parsed: { session_id?: unknown; turn_id?: unknown; hook_event_name?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HookParseError(`Malformed JSON: ${raw.slice(0, 100)}`);
  }
  return {
    rawSessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
    rawTurnId: typeof parsed.turn_id === 'string' ? parsed.turn_id : undefined,
    rawHookEventName: typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : undefined,
  };
}

export function parseHookEvent(raw: string): AgentEvent | null {
  let parsed: RawHookPayload;
  try {
    parsed = JSON.parse(raw) as RawHookPayload;
  } catch {
    throw new HookParseError(`Malformed JSON: ${raw.slice(0, 100)}`);
  }

  const hookName = parsed.hook_event_name;
  if (!KNOWN_HOOK_EVENTS.has(hookName)) {
    // Unknown hooks arrive when user's ~/.claude/settings.json has additional
    // hook types configured (--settings is additive). Silently skip them
    // instead of throwing — they are not errors, just events we don't use yet.
    return null;
  }

  const sessionId = parsed.session_id;
  const codexHookCapabilities = normalizeCodexHookCapabilities(parsed.codex_hook_capabilities);

  switch (hookName as HookEventName) {
    case 'SessionStart':
      return {
        type: 'session_start',
        sessionId,
        ...(parsed.transcript_path ? { transcriptPath: parsed.transcript_path } : {}),
        model: parsed.model,
        cwd: parsed.cwd,
        ...(codexHookCapabilities ? { codexHookCapabilities } : {}),
      };

    case 'PreToolUse':
      return {
        type: 'tool_use',
        sessionId,
        toolName: parsed.tool_name!,
        toolInput: parsed.tool_input,
        toolUseId: parsed.tool_use_id,
        cwd: parsed.cwd,
      };

    case 'PostToolUse':
      return {
        type: 'tool_result',
        sessionId,
        toolName: parsed.tool_name!,
        toolResponse: parsed.tool_response,
        toolUseId: parsed.tool_use_id,
        cwd: parsed.cwd,
      };

    case 'PostToolUseFailure':
      return {
        type: 'tool_error',
        sessionId,
        toolName: parsed.tool_name!,
        toolInput: parsed.tool_input,
        toolUseId: parsed.tool_use_id,
        error: parsed.error ?? '',
        isInterrupt: parsed.is_interrupt ?? false,
        cwd: parsed.cwd,
      };

    case 'Stop':
      return {
        type: 'stop',
        sessionId,
        lastMessage: parsed.last_assistant_message ?? '',
        cwd: parsed.cwd,
      };

    case 'StopFailure':
      return {
        type: 'stop_failure',
        sessionId,
        error: parsed.error ?? 'unknown',
        lastMessage: parsed.last_assistant_message ?? '',
        cwd: parsed.cwd,
      };

    case 'PermissionRequest':
      return {
        type: 'permission_request',
        sessionId,
        toolName: parsed.tool_name!,
        toolInput: parsed.tool_input,
        suggestions: parsed.permission_suggestions,
        cwd: parsed.cwd,
      };

    case 'Notification':
      return {
        type: 'notification',
        sessionId,
        notificationType: parsed.notification_type ?? '',
        message: parsed.message ?? '',
        cwd: parsed.cwd,
      };

    case 'UserPromptSubmit':
      return {
        type: 'user_prompt',
        sessionId,
        prompt: parsed.prompt ?? '',
        cwd: parsed.cwd,
      };

    case 'SubagentStart':
      return {
        type: 'subagent_start',
        sessionId,
        agentId: parsed.agent_id ?? '',
        agentType: parsed.agent_type ?? '',
        cwd: parsed.cwd,
      };

    case 'SubagentStop':
      return {
        type: 'subagent_stop',
        sessionId,
        agentId: parsed.agent_id ?? '',
        agentType: parsed.agent_type ?? '',
        lastMessage: parsed.last_assistant_message ?? '',
        agentTranscriptPath: parsed.agent_transcript_path,
        cwd: parsed.cwd,
      };

    case 'SessionEnd':
      return {
        type: 'session_end',
        sessionId,
        reason: parsed.reason ?? 'other',
      };
  }
}

function normalizeCodexHookCapabilities(
  raw: RawCodexHookCapabilities | undefined,
): CodexHookCapabilities | undefined {
  if (!raw) return undefined;
  const surfaceVersion = raw.surface_version;
  const supportedEvents = raw.supported_events?.filter(isKnownHookEventName) ?? [];
  if (typeof surfaceVersion !== 'number' || !Number.isInteger(surfaceVersion) || supportedEvents.length === 0) {
    return undefined;
  }

  return {
    surfaceVersion,
    supportedEvents,
    handlerFeatures: raw.handler_features
      ? { commandIf: raw.handler_features.command_if === true }
      : undefined,
  };
}

function isKnownHookEventName(value: string): value is HookEventName {
  return KNOWN_HOOK_EVENTS.has(value);
}
