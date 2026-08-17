// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentEvent } from '../../shared/protocol.js';
import { ActivityPanel, findInFlightTool, formatElapsed } from './ActivityPanel.js';

const sid = 's1';

describe('findInFlightTool', () => {
  test('returns the trailing tool_use that has no result yet', () => {
    const events: AgentEvent[] = [
      { type: 'user_prompt', sessionId: sid, prompt: 'go' },
      { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
    ];
    const inflight = findInFlightTool(events);
    expect(inflight).not.toBeNull();
    expect(inflight!.index).toBe(1);
    expect(inflight!.category).toBe('bash');
    expect(inflight!.label).toContain('npm test');
    expect(inflight!.key).toBe('b1');
  });

  test('returns null once the latest tool_use is closed by a matching result id', () => {
    const events: AgentEvent[] = [
      { type: 'tool_use', sessionId: sid, toolName: 'Read', toolUseId: 'r1' },
      { type: 'tool_result', sessionId: sid, toolName: 'Read', toolUseId: 'r1' },
    ];
    expect(findInFlightTool(events)).toBeNull();
  });

  test('pairs by toolName when the id is absent (older Codex sessions)', () => {
    const closed: AgentEvent[] = [
      { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'ls' } },
      { type: 'tool_result', sessionId: sid, toolName: 'Bash' },
    ];
    expect(findInFlightTool(closed)).toBeNull();

    const open: AgentEvent[] = [
      { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'ls' } },
    ];
    expect(findInFlightTool(open)?.category).toBe('bash');
  });

  test('treats a tool_error as closing the call', () => {
    const events: AgentEvent[] = [
      { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'flaky' }, toolUseId: 'b1' },
      { type: 'tool_error', sessionId: sid, toolName: 'Bash', toolUseId: 'b1', error: 'boom', isInterrupt: false },
    ];
    expect(findInFlightTool(events)).toBeNull();
  });

  test('surfaces the still-open call when an earlier parallel call has resolved', () => {
    const events: AgentEvent[] = [
      { type: 'tool_use', sessionId: sid, toolName: 'Read', toolUseId: 'a1' },
      { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
      { type: 'tool_result', sessionId: sid, toolName: 'Read', toolUseId: 'a1' },
    ];
    const inflight = findInFlightTool(events);
    expect(inflight!.key).toBe('b1');
    expect(inflight!.label).toContain('npm test');
  });

  test('surfaces the still-open call when an earlier parallel call errored', () => {
    const events: AgentEvent[] = [
      { type: 'tool_use', sessionId: sid, toolName: 'Read', toolUseId: 'a1' },
      { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
      { type: 'tool_error', sessionId: sid, toolName: 'Read', toolUseId: 'a1', error: 'boom', isInterrupt: false },
    ];
    expect(findInFlightTool(events)!.key).toBe('b1');
  });
});

describe('formatElapsed', () => {
  test('renders m:ss with a zero-padded seconds field', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5)).toBe('0:05');
    expect(formatElapsed(65)).toBe('1:05');
    expect(formatElapsed(600)).toBe('10:00');
  });

  test('floors negatives to 0:00 rather than emitting a negative clock', () => {
    expect(formatElapsed(-3)).toBe('0:00');
  });
});

describe('ActivityPanel live row', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  function render(events: AgentEvent[], isActive: boolean, props: Partial<React.ComponentProps<typeof ActivityPanel>> = {}): void {
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(ActivityPanel, { events, isActive, ...props }));
    });
  }

  test('shows the in-flight tool without also folding it into a completed group', () => {
    render(
      [
        { type: 'user_prompt', sessionId: sid, prompt: 'run the tests' },
        { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
      ],
      true,
    );
    const row = container.querySelector('[data-testid="act-live-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('npm test');
    // The open call must not appear a second time as a settled tool group.
    expect(container.querySelector('.act-tool-group')).toBeNull();
  });

  test('keeps a windowed launch placeholder while showing the open tool only as live', () => {
    render(
      [
        { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1', eventSeq: 51 },
      ],
      true,
      {
        agentId: 'kookr-test',
        description: 'Launch prompt',
        cwd: '/repo',
      },
    );

    const messages = [...container.querySelectorAll('.act-msg-user')].map((el) => el.textContent ?? '');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Launch prompt');
    expect(container.querySelector('[data-testid="act-live-row"]')!.textContent).toContain('npm test');
    expect(container.querySelector('.act-tool-group')).toBeNull();
  });

  test('keeps the completed history and shows only the open call live', () => {
    render(
      [
        { type: 'tool_use', sessionId: sid, toolName: 'Read', toolUseId: 'r1' },
        { type: 'tool_result', sessionId: sid, toolName: 'Read', toolUseId: 'r1' },
        { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
      ],
      true,
    );
    expect(container.querySelectorAll('.act-tool-group').length).toBe(1);
    expect(container.querySelector('[data-testid="act-live-row"]')!.textContent).toContain('npm test');
  });

  test('falls back to a generic working row between tool calls', () => {
    render(
      [
        { type: 'tool_use', sessionId: sid, toolName: 'Read', toolUseId: 'r1' },
        { type: 'tool_result', sessionId: sid, toolName: 'Read', toolUseId: 'r1' },
      ],
      true,
    );
    const row = container.querySelector('[data-testid="act-live-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Working');
  });

  test('renders no live row when the turn is not active', () => {
    render(
      [
        { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
      ],
      false,
    );
    expect(container.querySelector('[data-testid="act-live-row"]')).toBeNull();
  });

  test('shows the live row on an empty active turn instead of the empty state', () => {
    render([], true);
    expect(container.querySelector('[data-testid="act-live-row"]')).not.toBeNull();
    expect(container.querySelector('.act-empty')).toBeNull();
  });

  test('keeps an earlier parallel error visible while a later call is in-flight', () => {
    // Dropping the in-flight tool_use must not truncate the trailing tool_error
    // of an earlier parallel call — its completed group keeps the error pill.
    render(
      [
        { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'lint' }, toolUseId: 'a1' },
        { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
        { type: 'tool_error', sessionId: sid, toolName: 'Bash', toolUseId: 'a1', error: 'boom', isInterrupt: false },
      ],
      true,
    );
    expect(container.querySelector('[data-testid="act-live-row"]')!.textContent).toContain('npm test');
    expect(container.querySelector('.act-error-pill')).not.toBeNull();
  });
});
