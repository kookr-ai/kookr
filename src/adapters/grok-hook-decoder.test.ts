import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { HookParseError } from '../core/hook-parser.js';
import {
  extractGrokHookHeader,
  parseGrokHookEvent,
  GROK_TOOL_ALIASES,
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
    expect(e).toMatchObject({ type: 'session_start', sessionId: '019f5121-774f-73e0-b0c0-3b52114c3f07' });
    expect(e && 'cwd' in e ? e.cwd : undefined).toBe('<POC_TMP>/repo-main');
  });

  it('decodes user_prompt_submit into user_prompt', () => {
    const e = parseGrokHookEvent(line('user_prompt_submit'));
    expect(e?.type).toBe('user_prompt');
    expect(e && e.type === 'user_prompt' ? e.prompt : '').toContain('kookr-poc-sentinel');
  });

  it('decodes pre_tool_use with camelCase toolName/toolInput (no remap)', () => {
    const e = parseGrokHookEvent(line('pre_tool_use'));
    expect(e?.type).toBe('tool_use');
    if (e?.type !== 'tool_use') throw new Error('unreachable');
    expect(e.toolName).toBe('list_dir'); // Grok-native name preserved verbatim
    expect(e.toolInput).toEqual({ target_directory: '.' });
    expect(e.toolUseId).toBe('call-07ec244d-5295-49e4-a955-585cacbafa6b-0');
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
    for (const key of ['stop[error]', 'stop[cancelled]', 'stop[shutdown]']) {
      const e = parseGrokHookEvent(line(key));
      expect(e?.type).toBe('stop');
    }
  });

  it('decodes stop_failure with the 403 error text', () => {
    const e = parseGrokHookEvent(line('stop_failure'));
    expect(e?.type).toBe('stop_failure');
    expect(e && e.type === 'stop_failure' ? e.error : '').toContain('403');
  });

  it('decodes notification', () => {
    const e = parseGrokHookEvent(line('notification'));
    expect(e).toMatchObject({ type: 'notification', notificationType: 'idle_prompt', message: 'Turn complete' });
  });

  it('decodes subagent_start with child correlation (subagentId → agentId, distinct from sessionId)', () => {
    const e = parseGrokHookEvent(line('subagent_start'));
    expect(e?.type).toBe('subagent_start');
    if (e?.type !== 'subagent_start') throw new Error('unreachable');
    expect(e.agentId).toBe('019f5124-5fa6-7690-b866-a350f1d73c88');
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

  it('drops recognized-but-unmapped events (permission_denied, pre_compact)', () => {
    expect(parseGrokHookEvent(JSON.stringify({ hookEventName: 'permission_denied', sessionId: 's1' }))).toBeNull();
    expect(parseGrokHookEvent(JSON.stringify({ hookEventName: 'pre_compact', sessionId: 's1' }))).toBeNull();
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
    expect(h.rawSessionId).toBe('019f5121-774f-73e0-b0c0-3b52114c3f07');
    expect(h.rawHookEventName).toBe('user_prompt_submit');
    expect(h.rawTurnId).toBe('08ffd7dc-a4f7-478b-a1e1-f87649c3b334');
    expect(h.rawTranscriptPath).toContain('updates.jsonl');
  });

  it('documents the Claude→Grok tool aliases without applying them', () => {
    expect(GROK_TOOL_ALIASES.Bash).toBe('run_terminal_command');
    expect(GROK_TOOL_ALIASES.Task).toBe('spawn_subagent');
  });
});
