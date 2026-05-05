/**
 * Mock Claude Code hook events for E2E and integration testing.
 *
 * These fixtures represent the raw hook payloads that Claude Code sends
 * to hook commands via stdin. They are validated by the canary test
 * (e2e/canary.spec.ts) against real Claude Code behavior.
 *
 * If the canary test fails, update these fixtures to match the new
 * Claude Code behavior, then re-run all E2E tests.
 */

export interface RawHookEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  [key: string]: unknown;
}

let counter = 0;

/** Reset the auto-increment counter (call in beforeEach if needed). */
export function resetMockCounter(): void {
  counter = 0;
}

export function mockSessionStart(overrides?: Partial<RawHookEvent>): RawHookEvent {
  return {
    session_id: `sess-${++counter}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'SessionStart',
    ...overrides,
  };
}

export function mockStop(overrides?: Partial<RawHookEvent>): RawHookEvent {
  return {
    session_id: `sess-${++counter}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'Stop',
    stop_hook_active: true,
    last_assistant_message: 'I need your input to proceed.',
    ...overrides,
  };
}

export function mockPermissionRequest(overrides?: Partial<RawHookEvent>): RawHookEvent {
  return {
    session_id: `sess-${++counter}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    permission_mode: 'default',
    ...overrides,
  };
}

export function mockPreToolUse(
  toolName = 'Read',
  overrides?: Partial<RawHookEvent>,
): RawHookEvent {
  return {
    session_id: `sess-${++counter}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    ...overrides,
  };
}

export function mockPostToolUse(
  toolName = 'Read',
  overrides?: Partial<RawHookEvent>,
): RawHookEvent {
  return {
    session_id: `sess-${++counter}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_response: 'file contents...',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shape metadata — used by canary test to validate mock accuracy
// ---------------------------------------------------------------------------

/** Fields every real Claude Code hook event must contain. */
export const REQUIRED_HOOK_FIELDS = [
  'session_id',
  'transcript_path',
  'cwd',
  'hook_event_name',
] as const;

/** Expected fields per hook event type (superset of REQUIRED_HOOK_FIELDS). */
export const EVENT_SHAPE: Record<string, readonly string[]> = {
  SessionStart: [...REQUIRED_HOOK_FIELDS],
  PreToolUse: [...REQUIRED_HOOK_FIELDS, 'tool_name'],
  PostToolUse: [...REQUIRED_HOOK_FIELDS, 'tool_name'],
  Stop: [...REQUIRED_HOOK_FIELDS, 'stop_hook_active'],
  PermissionRequest: [...REQUIRED_HOOK_FIELDS, 'tool_name'],
};

/** All hook event types our mocks cover. */
export const MOCKED_EVENT_TYPES = Object.keys(EVENT_SHAPE);
