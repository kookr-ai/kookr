import { describe, test, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastAssistantMessage, parseTranscriptLine, parseTranscriptLines } from './transcript-parser.js';

const fixturesDir = join(import.meta.dirname, '..', '__fixtures__');

describe('Transcript JSONL Parser', () => {
  test('returns null for assistant text-only message (not in AgentEvent union)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will help you fix the bug.' }],
      },
      session_id: 'sess-1',
    });

    const event = parseTranscriptLine(line);
    expect(event).toBeNull();
  });

  test('parses tool_use content block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
      session_id: 'sess-1',
    });

    const event = parseTranscriptLine(line);
    expect(event).not.toBeNull();
    expect(event).toEqual({
      type: 'tool_use',
      sessionId: 'sess-1',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
    });
  });

  test('parses tool_result content block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: [{ type: 'text', text: 'test output here' }],
          },
        ],
      },
      session_id: 'sess-1',
    });

    const event = parseTranscriptLine(line);
    expect(event).not.toBeNull();
    expect(event).toEqual({
      type: 'tool_result',
      sessionId: 'sess-1',
      toolName: 'unknown',
      toolResponse: 'test output here',
    });
  });

  test('parses multiple JSONL lines', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/a.ts' } },
          ],
        },
        session_id: 'sess-1',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: [{ type: 'text', text: 'file content' }],
            },
          ],
        },
        session_id: 'sess-1',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_02', name: 'Edit', input: { file: '/a.ts' } },
          ],
        },
        session_id: 'sess-1',
      }),
    ];

    const events = parseTranscriptLines(lines);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('tool_use');
    expect(events[1].type).toBe('tool_result');
    expect(events[2].type).toBe('tool_use');
  });

  test('skips non-actionable entries (user message, system message)', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
        session_id: 'sess-1',
      }),
      JSON.stringify({
        type: 'system',
        session_id: 'sess-1',
        model: 'claude-sonnet-4-20250514',
      }),
    ];

    const events = parseTranscriptLines(lines);
    expect(events).toHaveLength(0);
  });

  test('handles malformed line gracefully - skips broken line', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        session_id: 'sess-1',
      }),
      'this is not valid json{{{',
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/b.ts' } },
          ],
        },
        session_id: 'sess-1',
      }),
    ];

    const events = parseTranscriptLines(lines);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('tool_use');
    expect(events[1].type).toBe('tool_use');
  });

  test('extracts cost info from result event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Done fixing the bug.',
      session_id: 'sess-1',
      total_cost_usd: 0.015,
      duration_ms: 45000,
      num_turns: 5,
    });

    const event = parseTranscriptLine(line);
    expect(event).not.toBeNull();
    expect(event).toEqual({
      type: 'stop',
      sessionId: 'sess-1',
      lastMessage: 'Done fixing the bug.',
    });
  });

  test('parses real fixture file', () => {
    const content = readFileSync(join(fixturesDir, 'transcript-sample.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    const events = parseTranscriptLines(lines);

    // From the fixture: tool_use (Read), tool_result, result (stop)
    // text-only assistant and user messages are skipped
    expect(events.length).toBeGreaterThanOrEqual(3);
  });
});

describe('lastAssistantMessage', () => {
  function withTempTranscript(content: string, fn: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-transcript-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, content, 'utf-8');
    try {
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('returns null for a missing transcript', () => {
    expect(lastAssistantMessage('/tmp/kookr-missing-transcript.jsonl')).toBeNull();
  });

  test('reads the last assistant text message from the transcript tail', () => {
    const first = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier message' }] },
    });
    const last = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Should I merge this PR?' }] },
    });

    withTempTranscript(`${first}\n${JSON.stringify({ type: 'user', message: 'ok' })}\n${last}\n`, (path) => {
      expect(lastAssistantMessage(path)).toEqual({
        excerpt: 'Should I merge this PR?',
        truncated: false,
        readAtOffset: Buffer.byteLength(`${first}\n${JSON.stringify({ type: 'user', message: 'ok' })}\n`, 'utf-8'),
      });
    });
  });

  test('treats a trailing result entry as the final assistant message', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier plan' }] },
    });
    const result = JSON.stringify({
      type: 'result',
      result: 'Final answer from the agent',
    });

    withTempTranscript(`${assistant}\n${result}\n`, (path) => {
      expect(lastAssistantMessage(path)?.excerpt).toBe('Final answer from the agent');
    });
  });

  test('uses the final result message from the real fixture', () => {
    const path = join(fixturesDir, 'transcript-sample.jsonl');
    expect(lastAssistantMessage(path)?.excerpt).toContain("I've fixed the auth bug");
  });

  test('truncates long assistant messages by character budget', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'abcdef' }] },
    });

    withTempTranscript(`${line}\n`, (path) => {
      expect(lastAssistantMessage(path, { maxChars: 3 })).toEqual({
        excerpt: 'abc',
        truncated: true,
        readAtOffset: 0,
      });
    });
  });

  test('drops a partial first tail line so multibyte cuts do not poison parsing', () => {
    const partial = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier café message' }] },
    });
    const target = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Latest intact message' }] },
    });

    withTempTranscript(`${partial}\n${target}\n`, (path) => {
      const result = lastAssistantMessage(path, { maxBytes: Buffer.byteLength(target, 'utf-8') + 8 });
      expect(result?.excerpt).toBe('Latest intact message');
      expect(result?.readAtOffset).toBe(Buffer.byteLength(`${partial}\n`, 'utf-8'));
    });
  });
});
