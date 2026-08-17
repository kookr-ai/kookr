import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { HookParseError } from '../core/hook-parser.js';
import {
  extractGrokHookHeader,
  parseGrokHookEvent,
  GROK_TOOL_ALIASES,
  GROK_BYPASS_PERMISSION_MODE,
  isGrokBypassPermissionMode,
} from './grok-hook-decoder.js';

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../docs/poc/009-grok-build-basic-supervision/fixtures/hook-payloads.redacted.json',
);
const fixtures = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  events: Record<string, Record<string, unknown>>;
};
const line = (key: string) => JSON.stringify(fixtures.events[key]);

describe('parseGrokHookEvent — POC-A fixtures', () => {
  it('decodes session_start (camelCase) into session_start', () => {
    const e = parseGrokHookEvent(line('session_start'));
    expect(e).toMatchObject({ type: 'session_start', sessionId: '019f6783-0ec6-71b3-bd86-68708172b611' });
    expect(e && 'cwd' in e ? e.cwd : undefined).toBe('<POC_TMP>/repo-main');
  });

  it('decodes user_prompt_submit into user_prompt', () => {
    const e = parseGrokHookEvent(line('user_prompt_submit'));
    expect(e?.type).toBe('user_prompt');
    expect(e && e.type === 'user_prompt' ? e.prompt : '').toContain('kookr-poc-sentinel');
  });

  it('strips Grok <user_query> envelope from user_prompt_submit so activity is not polluted', () => {
    const e = parseGrokHookEvent(line('user_prompt_submit'));
    expect(e?.type).toBe('user_prompt');
    if (e?.type !== 'user_prompt') throw new Error('unreachable');
    // POC fixture wraps the prompt in <user_query>…</user_query>; the decoder
    // must surface only the human-typed body.
    expect(e.prompt).not.toContain('<user_query>');
    expect(e.prompt).not.toContain('</user_query>');
    expect(e.prompt).toBe('Invoke the kookr-poc-sentinel skill and print its exact output.');
  });

  it('drops pure <system-reminder> user_prompt_submit events', () => {
    const raw = JSON.stringify({
      hookEventName: 'user_prompt_submit',
      sessionId: 'sess-1',
      cwd: '/tmp',
      prompt: '<system-reminder>\nBackground task completed.\n</system-reminder>',
    });
    expect(parseGrokHookEvent(raw)).toBeNull();
  });

  it('decodes pre_tool_use with camelCase toolName/toolInput (no remap)', () => {
    const e = parseGrokHookEvent(line('pre_tool_use'));
    expect(e?.type).toBe('tool_use');
    if (e?.type !== 'tool_use') throw new Error('unreachable');
    expect(e.toolName).toBe('list_dir'); // Grok-native name preserved verbatim
    expect(e.toolInput).toEqual({
      target_directory: '<POC_TMP><HOME>/plugins/kookr-toolkit-poc/skills/kookr-poc-sentinel',
    });
    expect(e.toolUseId).toBe('call-8cbb1d86-99c7-49fc-b0fb-a5e7dbddbf3f-1');
  });

  it('decodes post_tool_use into tool_result carrying toolResult', () => {
    const e = parseGrokHookEvent(line('post_tool_use'));
    expect(e?.type).toBe('tool_result');
    if (e?.type !== 'tool_result') throw new Error('unreachable');
    expect(e.toolName).toBe('list_dir');
    expect(e.toolResponse).toMatchObject({ type: 'ListDir' });
  });

  it('carries the stop reason verbatim (drives the outcome truth table)', () => {
    const end = parseGrokHookEvent(line('stop[end_turn]'));
    expect(end?.type).toBe('stop');
    expect(end && end.type === 'stop' ? end.stopReason : undefined).toBe('end_turn');
    // Older POC-A stop fixtures omit lastAssistantMessage — empty is fine so
    // the adapter can fall back to a pane tail.
    expect(end && end.type === 'stop' ? end.lastMessage : undefined).toBe('');
    for (const key of ['stop[error]', 'stop[cancelled]', 'stop[shutdown]']) {
      const e = parseGrokHookEvent(line(key));
      expect(e?.type).toBe('stop');
    }
  });

  it('maps lastAssistantMessage on stop into lastMessage for the activity panel', () => {
    // Live Grok (≥0.2.x) includes the final assistant turn as camelCase
    // lastAssistantMessage. Without this mapping the activity panel only
    // shows "You" rows and the operator has to read the terminal for answers.
    const raw = JSON.stringify({
      hookEventName: 'stop',
      sessionId: 'sess-1',
      cwd: '/tmp',
      reason: 'end_turn',
      promptId: 'turn-1',
      lastAssistantMessage: '## Done\n\nThe fix is deployed and verified.',
    });
    const e = parseGrokHookEvent(raw);
    expect(e).toMatchObject({
      type: 'stop',
      sessionId: 'sess-1',
      stopReason: 'end_turn',
      lastMessage: '## Done\n\nThe fix is deployed and verified.',
      turnId: 'turn-1',
    });
  });

  it('maps lastAssistantMessage on subagent_stop into lastMessage', () => {
    const raw = JSON.stringify({
      hookEventName: 'subagent_stop',
      sessionId: 'sess-1',
      subagentId: 'child-1',
      subagentType: 'explore',
      lastAssistantMessage: 'Found 3 matching files.',
    });
    const e = parseGrokHookEvent(raw);
    expect(e).toMatchObject({
      type: 'subagent_stop',
      agentId: 'child-1',
      lastMessage: 'Found 3 matching files.',
    });
  });

  it('decodes stop_failure with the HTTP error text', () => {
    const e = parseGrokHookEvent(line('stop_failure'));
    expect(e?.type).toBe('stop_failure');
    expect(e && e.type === 'stop_failure' ? e.error : '').toContain('401');
  });

  it('normalizes the permission_prompt notification into permission_request (issue #1526 Phase C4)', () => {
    // POC-A capture: Grok's interactive permission prompt surfaces as
    // notification{notificationType:"permission_prompt"} and Grok has no
    // PermissionRequest hook event, so this is the structured signal that the
    // agent is parked on a permission menu. It must decode into the same
    // AgentEvent Claude's PermissionRequest produces, so the anomaly detector
    // classifies the session permission_blocked and Phase B's
    // stuckReason: 'permission_blocked' fires for Grok tasks.
    const e = parseGrokHookEvent(line('notification'));
    expect(e).toMatchObject({
      type: 'permission_request',
      sessionId: '019f6783-5c28-7210-a98e-0be0aa657627',
    });
  });

  it('decodes non-permission notifications as plain notification', () => {
    const e = parseGrokHookEvent(JSON.stringify({
      hookEventName: 'notification',
      sessionId: 's1',
      notificationType: 'idle_prompt',
      message: 'waiting for input',
    }));
    expect(e).toMatchObject({
      type: 'notification',
      notificationType: 'idle_prompt',
      message: 'waiting for input',
    });
  });

  it('decodes subagent_start with child correlation (subagentId → agentId, distinct from sessionId)', () => {
    const e = parseGrokHookEvent(line('subagent_start'));
    expect(e?.type).toBe('subagent_start');
    if (e?.type !== 'subagent_start') throw new Error('unreachable');
    expect(e.agentId).toBe('019f6783-f798-7ef1-9371-1e4534e51053');
    expect(e.agentType).toBe('general-purpose');
    expect(e.agentId).not.toBe(e.sessionId);
  });

  it('decodes session_end with reason', () => {
    const e = parseGrokHookEvent(line('session_end'));
    expect(e).toMatchObject({ type: 'session_end', reason: 'shutdown' });
  });
});

describe('parseGrokHookEvent — robustness', () => {
  it('throws HookParseError on malformed JSON', () => {
    expect(() => parseGrokHookEvent('{not json')).toThrow(HookParseError);
    expect(() => extractGrokHookHeader('{not json')).toThrow(HookParseError);
  });

  it('drops (returns null) an unknown hookEventName without throwing', () => {
    expect(parseGrokHookEvent(JSON.stringify({ hookEventName: 'made_up', sessionId: 's1' }))).toBeNull();
  });

  it('drops recognized-but-unmapped events (pre_compact, post_compact)', () => {
    expect(parseGrokHookEvent(JSON.stringify({ hookEventName: 'pre_compact', sessionId: 's1' }))).toBeNull();
    expect(parseGrokHookEvent(JSON.stringify({ hookEventName: 'post_compact', sessionId: 's1' }))).toBeNull();
  });

  it('decodes permission_denied into permission_request (2026-07-24 incident: was dropped, hiding a 33h permission-stuck task)', () => {
    // No POC-A payload capture exists for permission_denied (it did not fire
    // in the headless runs), so the shape mirrors the camelCase tool-event
    // conventions of every other captured Grok payload.
    const e = parseGrokHookEvent(JSON.stringify({
      hookEventName: 'permission_denied',
      sessionId: 's1',
      cwd: '/repo',
      toolName: 'search_replace',
      toolInput: { file_path: '/repo/a.ts' },
    }));
    expect(e).toMatchObject({
      type: 'permission_request',
      sessionId: 's1',
      toolName: 'search_replace',
      toolInput: { file_path: '/repo/a.ts' },
      cwd: '/repo',
    });
  });

  it('decodes a field-less permission_denied defensively rather than dropping it', () => {
    const e = parseGrokHookEvent(JSON.stringify({ hookEventName: 'permission_denied', sessionId: 's1' }));
    expect(e).toMatchObject({ type: 'permission_request', sessionId: 's1', toolName: '' });
  });

  it('does not treat bypass permission_prompt as a blocking wait', () => {
    // Live 2026-08-17: grok-build in --permission-mode bypassPermissions still
    // emits notification{permission_prompt, "Tool permission requested"} while
    // the tool succeeds. Mapping that to permission_request flickers
    // permission_blocked / "permission required" on every such hook.
    const e = parseGrokHookEvent(JSON.stringify({
      hookEventName: 'notification',
      sessionId: 's1',
      notificationType: 'permission_prompt',
      message: 'Tool permission requested',
      permissionMode: GROK_BYPASS_PERMISSION_MODE,
    }));
    expect(e).toMatchObject({
      type: 'notification',
      sessionId: 's1',
      notificationType: 'permission_prompt',
      message: 'Tool permission requested',
    });
    expect(e?.type).not.toBe('permission_request');
  });

  it('keeps non-bypass permission_prompt as permission_request (issue #1526 Phase C4)', () => {
    const e = parseGrokHookEvent(JSON.stringify({
      hookEventName: 'notification',
      sessionId: 's1',
      notificationType: 'permission_prompt',
      message: 'Tool permission requested',
      permissionMode: 'default',
    }));
    expect(e).toMatchObject({ type: 'permission_request', sessionId: 's1' });
  });

  it('decodes bypass permission_denied as a completed tool error, not a wait', () => {
    // Hook/policy deny under bypass: the tool was rejected and the agent
    // continues. permission_request would ask the operator to approve a
    // decision that already happened.
    const e = parseGrokHookEvent(JSON.stringify({
      hookEventName: 'permission_denied',
      sessionId: 's1',
      cwd: '/repo',
      toolName: 'run_terminal_command',
      toolUseId: 'call-1',
      toolInput: { command: 'cat .env' },
      permissionMode: GROK_BYPASS_PERMISSION_MODE,
    }));
    expect(e).toMatchObject({
      type: 'tool_error',
      sessionId: 's1',
      toolName: 'run_terminal_command',
      toolUseId: 'call-1',
      error: 'permission_denied',
      isInterrupt: false,
      cwd: '/repo',
    });
  });

  it('documents the bypass permission-mode token', () => {
    expect(isGrokBypassPermissionMode(GROK_BYPASS_PERMISSION_MODE)).toBe(true);
    expect(isGrokBypassPermissionMode('default')).toBe(false);
    expect(isGrokBypassPermissionMode(undefined)).toBe(false);
  });

  it('drops an event missing its sessionId correlation key', () => {
    expect(parseGrokHookEvent(JSON.stringify({ hookEventName: 'stop', reason: 'end_turn' }))).toBeNull();
  });

  it('does NOT decode Claude snake_case payloads (schema divergence)', () => {
    const claudeShaped = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' });
    // snake_case hookEventName/sessionId are absent → dropped, never mis-decoded.
    expect(parseGrokHookEvent(claudeShaped)).toBeNull();
  });

  it('extractGrokHookHeader pulls camelCase correlation keys (promptId as turn id)', () => {
    const h = extractGrokHookHeader(line('user_prompt_submit'));
    expect(h.rawSessionId).toBe('019f6783-0ec6-71b3-bd86-68708172b611');
    expect(h.rawHookEventName).toBe('user_prompt_submit');
    expect(h.rawTurnId).toBe('30414cf9-e6ae-4e53-9adc-74547c104366');
    expect(h.rawTranscriptPath).toContain('updates.jsonl');
  });

  it('documents the Claude→Grok tool aliases without applying them', () => {
    expect(GROK_TOOL_ALIASES.Bash).toBe('run_terminal_command');
    expect(GROK_TOOL_ALIASES.Task).toBe('spawn_subagent');
  });
});
