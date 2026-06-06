// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentEvent } from '../../shared/protocol.js';
import { ActivityPanel } from './ActivityPanel.js';

function renderActivity(container: HTMLElement, events: AgentEvent[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ActivityPanel, { events }));
  });
  return root;
}

describe('ActivityPanel role distinction', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  test('user and agent messages carry distinct, decorative avatar chips', () => {
    root = renderActivity(container, [
      { type: 'user_prompt', sessionId: 's1', prompt: 'please fix the test' },
      { type: 'stop', sessionId: 's1', lastMessage: 'done' },
    ]);

    const userAvatar = container.querySelector('.act-msg-user .act-msg-avatar');
    const agentAvatar = container.querySelector('.act-msg-agent .act-msg-avatar');

    expect(userAvatar?.classList.contains('act-avatar-user')).toBe(true);
    expect(agentAvatar?.classList.contains('act-avatar-agent')).toBe(true);
    expect(userAvatar?.textContent).toBe('Y');
    expect(agentAvatar?.textContent).toBe('A');

    // Avatars are a visual cue only — the text label still conveys the role to
    // assistive tech, so the chips must be hidden from it to avoid "Y You".
    expect(userAvatar?.getAttribute('aria-hidden')).toBe('true');
    expect(agentAvatar?.getAttribute('aria-hidden')).toBe('true');
  });

  test('the role label keeps its accent class while text moves into a body wrapper', () => {
    root = renderActivity(container, [
      { type: 'user_prompt', sessionId: 's1', prompt: 'hello there' },
      { type: 'stop', sessionId: 's1', lastMessage: 'hi back' },
    ]);

    const userLabel = container.querySelector('.act-msg-user .act-label-user');
    expect(userLabel?.textContent).toBe('You');

    // Message text now lives inside .act-msg-body alongside the header.
    const userText = container.querySelector('.act-msg-user .act-msg-body .act-msg-text');
    expect(userText?.textContent).toContain('hello there');
    const agentText = container.querySelector('.act-msg-agent .act-msg-body .act-msg-text');
    expect(agentText?.textContent).toContain('hi back');
  });

  test('a paste burst keeps a single user avatar and its disclosure', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `{"n": ${i}}`);
    root = renderActivity(
      container,
      lines.map((prompt) => ({ type: 'user_prompt', sessionId: 's1', prompt })),
    );

    const burstAvatar = container.querySelector('.act-msg-paste-burst .act-avatar-user');
    expect(burstAvatar?.textContent).toBe('Y');
    expect(burstAvatar?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.act-msg-paste-burst .act-avatar-user')).toHaveLength(1);
    expect(container.querySelector('.act-msg-paste-burst .act-msg-body .act-paste-burst')).not.toBeNull();
  });
});
