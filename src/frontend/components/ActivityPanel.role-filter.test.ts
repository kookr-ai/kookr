// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentEvent } from '../../shared/protocol.js';
import { ACTIVITY_ROLE_FILTER_KEY } from '../activity-role-filter.js';
import { ActivityPanel } from './ActivityPanel.js';

const sid = 's1';

const mixedEvents: AgentEvent[] = [
  { type: 'user_prompt', sessionId: sid, prompt: 'please fix the test' },
  { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
  { type: 'tool_result', sessionId: sid, toolName: 'Bash', toolUseId: 'b1' },
  { type: 'stop', sessionId: sid, lastMessage: 'tests are green' },
];

function renderActivity(
  container: HTMLElement,
  events: AgentEvent[],
  props: Partial<React.ComponentProps<typeof ActivityPanel>> = {},
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ActivityPanel, { events, ...props }));
  });
  return root;
}

function chip(container: HTMLElement, filter: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-testid="activity-role-chip-${filter}"]`)!;
}

describe('ActivityPanel role-filter chips (issue #2576)', () => {
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
    localStorage.clear();
  });

  test('renders All / You / Agent / Tools chips and starts on All', () => {
    root = renderActivity(container, mixedEvents);

    expect(chip(container, 'all').textContent).toBe('All');
    expect(chip(container, 'you').textContent).toBe('You');
    expect(chip(container, 'agent').textContent).toBe('Agent');
    expect(chip(container, 'tools').textContent).toBe('Tools');
    expect(chip(container, 'all').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('.act-msg-user')).not.toBeNull();
    expect(container.querySelector('.act-msg-agent')).not.toBeNull();
    expect(container.querySelector('.act-tool-group')).not.toBeNull();
  });

  test('selecting Tools hides user and assistant rows and keeps tool rows', () => {
    root = renderActivity(container, mixedEvents);

    act(() => chip(container, 'tools').dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelector('.act-msg-user')).toBeNull();
    expect(container.querySelector('.act-msg-agent')).toBeNull();
    expect(container.querySelector('.act-tool-group')).not.toBeNull();
    expect(container.querySelector('.act-tool-group')?.textContent).toMatch(/command/i);
    expect(container.querySelector('[data-testid="act-empty-filter"]')).toBeNull();
    expect(chip(container, 'tools').getAttribute('aria-checked')).toBe('true');
    expect(chip(container, 'all').getAttribute('aria-checked')).toBe('false');
  });

  test('keeps the live working row visible when Tools is hidden', () => {
    root = renderActivity(
      container,
      [
        { type: 'user_prompt', sessionId: sid, prompt: 'run the tests' },
        { type: 'tool_use', sessionId: sid, toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'b1' },
      ],
      { isActive: true },
    );

    act(() => chip(container, 'you').dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelector('.act-tool-group')).toBeNull();
    expect(container.querySelector('[data-testid="act-live-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="act-live-row"]')?.textContent).toContain('npm test');
    expect(container.querySelector('.act-msg-user')).not.toBeNull();
  });

  test('persists the last chip choice in localStorage and restores it on remount', () => {
    root = renderActivity(container, mixedEvents);

    act(() => chip(container, 'agent').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(localStorage.getItem(ACTIVITY_ROLE_FILTER_KEY)).toBe('agent');
    expect(container.querySelector('.act-msg-user')).toBeNull();
    expect(container.querySelector('.act-msg-agent')?.textContent).toContain('tests are green');

    act(() => root?.unmount());
    root = null;
    root = renderActivity(container, mixedEvents);

    expect(chip(container, 'agent').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('.act-msg-user')).toBeNull();
    expect(container.querySelector('.act-msg-agent')?.textContent).toContain('tests are green');
    expect(container.querySelector('.act-tool-group')).toBeNull();
  });

  test('shows a No matching activity recovery that returns to All', () => {
    root = renderActivity(container, [
      { type: 'user_prompt', sessionId: sid, prompt: 'please fix the test' },
    ]);

    act(() => chip(container, 'tools').dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const empty = container.querySelector('[data-testid="act-empty-filter"]');
    expect(empty?.textContent).toContain('No matching activity');
    const clear = container.querySelector<HTMLButtonElement>('[data-testid="activity-role-filter-clear"]');
    expect(clear).not.toBeNull();

    act(() => clear!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(chip(container, 'all').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-testid="act-empty-filter"]')).toBeNull();
    expect(container.querySelector('.act-msg-user')?.textContent).toContain('please fix the test');
  });
});
