import { describe, test, expect } from 'vitest';
import { capMessagesKeepingTail, normalizeLedgerEvents, normalizeVendorLines } from './transcript-normalizer.js';
import type { AgentEvent } from './types.js';

describe('normalizeVendorLines', () => {
  test('maps user, assistant text, tool_use and tool_result; skips junk', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] },
      ] } }),
      JSON.stringify({ type: 'system', content: 'ignored' }),
    ];
    expect(normalizeVendorLines(lines)).toEqual([
      { kind: 'text', role: 'user', text: 'hello' },
      { kind: 'text', role: 'assistant', text: 'working' },
      { kind: 'tool_call', name: 'Bash', input: '{"command":"ls"}' },
      { kind: 'tool_result', name: 'Bash', text: 'a.txt' },
    ]);
  });

  test('per-message cap truncates and adds a marker; tool_result flagged', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(100) }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'y'.repeat(100) }] } }),
    ];
    const out = normalizeVendorLines(lines, { maxMessageBytes: 10 });
    expect(out[0]).toEqual({ kind: 'text', role: 'assistant', text: 'x'.repeat(10) });
    expect(out[1].kind).toBe('truncation_marker');
    expect(out[2]).toEqual({ kind: 'tool_result', text: 'y'.repeat(10), truncated: true });
  });

  test('total cap stops with a truncation_marker', () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `message number ${i}` } }));
    const out = normalizeVendorLines(lines, { maxTotalBytes: 300 });
    expect(out.length).toBeLessThan(50);
    expect(out[out.length - 1].kind).toBe('truncation_marker');
  });
});

describe('normalizeLedgerEvents', () => {
  test('maps prompt, tools and stop lastMessage in order; drops empty answers', () => {
    const events = [
      { type: 'user_prompt', sessionId: 's', prompt: 'do it' },
      { type: 'tool_use', sessionId: 's', toolName: 'Read', toolInput: { file: 'a' } },
      { type: 'tool_result', sessionId: 's', toolName: 'Read', toolResponse: 'contents' },
      { type: 'stop', sessionId: 's', lastMessage: '' },
      { type: 'stop', sessionId: 's', lastMessage: 'done!' },
      { type: 'subagent_stop', sessionId: 's', agentId: 'a', agentType: 'x', lastMessage: 'sub answer' },
      { type: 'notification', sessionId: 's', notificationType: 'n', message: 'm' },
    ] as unknown as AgentEvent[];
    expect(normalizeLedgerEvents(events)).toEqual([
      { kind: 'text', role: 'user', text: 'do it' },
      { kind: 'tool_call', name: 'Read', input: '{"file":"a"}' },
      { kind: 'tool_result', name: 'Read', text: 'contents' },
      { kind: 'text', role: 'assistant', text: 'done!' },
      { kind: 'text', role: 'assistant', text: 'sub answer' },
    ]);
  });

  test('byte cap yields a truncation_marker', () => {
    const events = Array.from({ length: 20 }, () => ({ type: 'stop', sessionId: 's', lastMessage: 'z'.repeat(50) })) as unknown as AgentEvent[];
    const out = normalizeLedgerEvents(events, { maxTotalBytes: 200 });
    expect(out[out.length - 1].kind).toBe('truncation_marker');
  });
});

describe('capMessagesKeepingTail', () => {
  const t = (text: string) => ({ kind: 'text' as const, role: 'assistant' as const, text });
  test('returns input unchanged when within budget', () => {
    const msgs = [t('a'), t('b')];
    expect(capMessagesKeepingTail(msgs, 10_000)).toEqual(msgs);
  });
  test('keeps the tail and prepends one marker when dropping', () => {
    const msgs = [t('x'.repeat(100)), t('y'.repeat(100)), t('final')];
    const out = capMessagesKeepingTail(msgs, 150);
    expect(out[0]).toMatchObject({ kind: 'truncation_marker' });
    expect(out.filter((m) => m.kind === 'truncation_marker')).toHaveLength(1);
    expect(out[out.length - 1]).toEqual(t('final'));
    expect(out).toHaveLength(2);
  });
  test('keeps the last message even when it alone exceeds the budget', () => {
    const out = capMessagesKeepingTail([t('a'), t('z'.repeat(500))], 50);
    expect(out[out.length - 1]).toEqual(t('z'.repeat(500)));
    expect(out[0]).toMatchObject({ kind: 'truncation_marker' });
  });
});
