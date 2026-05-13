import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHookEvent, HookParseError } from './hook-parser.js';

const fixturesDir = join(import.meta.dirname, '..', '__fixtures__');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

describe('Hook Event Parser', () => {
  test('parses SessionStart hook', () => {
    const raw = loadFixture('hook-session-start.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'session_start',
      sessionId: 'ecdffeda-e0fc-490d-9efe-3347d80fb85e',
      transcriptPath:
        '~/.claude/projects/-home-jean-git-kookr/ecdffeda-e0fc-490d-9efe-3347d80fb85e.jsonl',
      model: 'claude-sonnet-4-20250514',
      cwd: '/workspace/kookr',
    });
  });

  test('parses SessionStart hook with codex capability advertisement', () => {
    const raw = JSON.stringify({
      session_id: 'codex-session-123',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/workspace/kookr',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'gpt-5.4',
      codex_hook_capabilities: {
        surface_version: 2,
        supported_events: ['SessionStart', 'Notification', 'Stop', 'UnknownFutureEvent'],
        handler_features: { command_if: true },
      },
    });
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'session_start',
      sessionId: 'codex-session-123',
      transcriptPath: '/path/to/transcript.jsonl',
      model: 'gpt-5.4',
      cwd: '/workspace/kookr',
      codexHookCapabilities: {
        surfaceVersion: 2,
        supportedEvents: ['SessionStart', 'Notification', 'Stop'],
        handlerFeatures: { commandIf: true },
      },
    });
  });

  test('parses PreToolUse hook', () => {
    const raw = loadFixture('hook-pre-tool-use.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'tool_use',
      sessionId: 'ecdffeda-e0fc-490d-9efe-3347d80fb85e',
      toolName: 'Bash',
      toolInput: { command: 'ls -la', description: 'List files' },
      toolUseId: 'toolu_01ABC123',
      cwd: '/workspace/kookr',
    });
  });

  test('parses PostToolUse hook', () => {
    const raw = loadFixture('hook-post-tool-use.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'tool_result',
      sessionId: 'ecdffeda-e0fc-490d-9efe-3347d80fb85e',
      toolName: 'Bash',
      toolResponse: {
        stdout:
          'total 8\ndrwxr-xr-x 2 user user 4096 Mar 24 10:00 .\ndrwxr-xr-x 3 user user 4096 Mar 24 10:00 ..',
      },
      toolUseId: 'toolu_01ABC123',
      cwd: '/workspace/kookr',
    });
  });

  test('parses Stop hook', () => {
    const raw = loadFixture('hook-stop.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'stop',
      sessionId: 'ecdffeda-e0fc-490d-9efe-3347d80fb85e',
      lastMessage:
        'There are **4 hook types** in this file: PreToolUse, PostToolUse, Stop, and SessionStart.',
      cwd: '/workspace/kookr',
    });
  });

  test('parses PermissionRequest hook', () => {
    const raw = loadFixture('hook-permission-request.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'permission_request',
      sessionId: 'e5a32157-98b3-4b34-95be-173437f1dc13',
      toolName: 'Bash',
      toolInput: {
        command: 'mkdir -p /tmp/kookr-poc',
        description: 'Create parent directory',
      },
      suggestions: [
        {
          type: 'addDirectories',
          directories: ['/tmp/kookr-poc'],
          destination: 'session',
        },
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        },
      ],
      cwd: '/workspace/kookr',
    });
  });

  test('parses Notification (idle_prompt) hook', () => {
    const raw = loadFixture('hook-notification-idle.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'notification',
      sessionId: '8ee8ff7c-c7ef-4abf-8b03-ff8777ff8916',
      notificationType: 'idle_prompt',
      message: 'Claude is waiting for your input',
      cwd: '/workspace/kookr',
    });
  });

  test('parses UserPromptSubmit hook', () => {
    const raw = loadFixture('hook-user-prompt-submit.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'user_prompt',
      sessionId: '8ee8ff7c-c7ef-4abf-8b03-ff8777ff8916',
      prompt: 'say hello',
      cwd: '/workspace/kookr',
    });
  });

  test('drops UserPromptSubmit synthetic <task-notification> re-entry', () => {
    const raw = loadFixture('hook-user-prompt-submit-task-notification.json');
    expect(parseHookEvent(raw)).toBeNull();
  });

  test('parses StopFailure hook', () => {
    const raw = loadFixture('hook-stop-failure.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'stop_failure',
      sessionId: '43871e1c-0f8f-4e21-9fc3-59b18e4a5585',
      error: 'billing_error',
      lastMessage: 'Credit balance is too low',
      cwd: '/workspace/kookr',
    });
  });

  test('parses PostToolUseFailure hook', () => {
    const raw = loadFixture('hook-post-tool-use-failure.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'tool_error',
      sessionId: 'ef2bb325-8a22-4eec-a5df-708b6a00a609',
      toolName: 'Read',
      toolInput: { file_path: '/nonexistent/file.txt' },
      toolUseId: 'toolu_01KZT2BTx2q68JSaK5hCJDkv',
      error: 'File does not exist.',
      isInterrupt: false,
      cwd: '/workspace/kookr',
    });
  });

  test('parses SubagentStart hook', () => {
    const raw = loadFixture('hook-subagent-start.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'subagent_start',
      sessionId: 'ef2bb325-8a22-4eec-a5df-708b6a00a609',
      agentId: 'a9af72eb6cf1b8c97',
      agentType: 'Explore',
      cwd: '/workspace/kookr',
    });
  });

  test('parses SubagentStop hook', () => {
    const raw = loadFixture('hook-subagent-stop.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'subagent_stop',
      sessionId: 'ef2bb325-8a22-4eec-a5df-708b6a00a609',
      agentId: 'a9af72eb6cf1b8c97',
      agentType: 'Explore',
      lastMessage: 'Found 1 .json file in /tmp/kookr-poc-003/',
      agentTranscriptPath: '~/.claude/projects/-home-jean-git-kookr/ef2bb325/subagents/agent-a9af72eb6cf1b8c97.jsonl',
      cwd: '/workspace/kookr',
    });
  });

  test('parses SessionEnd hook', () => {
    const raw = loadFixture('hook-session-end.json');
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'session_end',
      sessionId: '8ee8ff7c-c7ef-4abf-8b03-ff8777ff8916',
      reason: 'prompt_input_exit',
    });
  });

  test('rejects malformed JSON', () => {
    expect(() => parseHookEvent('not json')).toThrow(HookParseError);
  });

  test('returns null for unknown hook event (user hooks are additive)', () => {
    const raw = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path',
      cwd: '/cwd',
      hook_event_name: 'InstructionsLoaded',
    });
    expect(parseHookEvent(raw)).toBeNull();
  });

  test('handles missing optional fields in PreToolUse', () => {
    const raw = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path',
      cwd: '/cwd',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 'toolu_01',
    });
    const event = parseHookEvent(raw);

    expect(event).toEqual({
      type: 'tool_use',
      sessionId: 'sess-1',
      toolName: 'Read',
      toolInput: undefined,
      toolUseId: 'toolu_01',
      cwd: '/cwd',
    });
  });
});
