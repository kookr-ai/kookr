import { describe, expect, test } from 'vitest';
import { splitHookRecords, splitHookRequestBody } from './hook-record-framing.js';

describe('hook record framing', () => {
  test('splitHookRecords separates concatenated hook JSON objects', () => {
    const event1 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    const event2 = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'printf "}{"' },
    });

    expect(splitHookRecords(`${event1}${event2}`)).toEqual({
      records: [event1, event2],
      consumedChars: event1.length + event2.length,
    });
  });

  test('splitHookRecords leaves incomplete trailing JSON for the next read', () => {
    const event = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });
    const partial = '{"session_id":"sess-2"';

    expect(splitHookRecords(`${event}${partial}`)).toEqual({
      records: [event],
      consumedChars: event.length,
    });
  });

  test('splitHookRequestBody continues after malformed JSONL lines', () => {
    const event = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/cwd',
      hook_event_name: 'SessionStart',
    });

    expect(splitHookRequestBody(`{"broken":\n${event}\n`)).toEqual([
      '{"broken":',
      event,
    ]);
  });
});
