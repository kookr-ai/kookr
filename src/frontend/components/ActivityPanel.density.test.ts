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

describe('ActivityPanel density', () => {
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

  test('collapses oversized launch prompts behind an explicit expander', () => {
    const prompt = Array.from({ length: 80 }, (_, i) => `Step ${i + 1}: perform one bounded action.`).join('\n');
    root = renderActivity(container, [{ type: 'user_prompt', sessionId: 's1', prompt }]);

    const message = container.querySelector('.act-msg-user')!;
    expect(message.classList.contains('act-msg-collapsed')).toBe(true);
    expect(message.querySelector('.act-msg-full')).not.toBeNull();
    expect(message.querySelector('summary')?.textContent).toContain('Show full prompt');
    expect(message.textContent).toContain('Step 1: perform one bounded action.');
  });

  test('stays pinned to the latest activity while auto-scroll is locked', () => {
    let scrollHeight = 120;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100 });

    root = renderActivity(container, [{ type: 'user_prompt', sessionId: 's1', prompt: 'Start' }]);
    const panel = container.querySelector<HTMLDivElement>('.activity-panel')!;
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: () => scrollHeight });

    scrollHeight = 520;
    act(() => {
      root!.render(React.createElement(ActivityPanel, {
        events: [
          { type: 'user_prompt', sessionId: 's1', prompt: 'Start' },
          { type: 'stop', sessionId: 's1', lastMessage: 'Latest message' },
        ],
      }));
    });

    expect(panel.scrollTop).toBe(520);
    expect(container.querySelector('.act-jump-bottom')).toBeNull();
  });

  test('unlocks auto-scroll when the user scrolls up and relocks via jump to latest', () => {
    let scrollHeight = 300;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100 });

    root = renderActivity(container, [
      { type: 'user_prompt', sessionId: 's1', prompt: 'Start' },
      { type: 'stop', sessionId: 's1', lastMessage: 'One' },
    ]);
    const panel = container.querySelector<HTMLDivElement>('.activity-panel')!;
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: () => scrollHeight });

    act(() => {
      panel.scrollTop = 20;
      panel.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    scrollHeight = 620;
    act(() => {
      root!.render(React.createElement(ActivityPanel, {
        events: [
          { type: 'user_prompt', sessionId: 's1', prompt: 'Start' },
          { type: 'stop', sessionId: 's1', lastMessage: 'One' },
          { type: 'stop', sessionId: 's1', lastMessage: 'Two' },
        ],
      }));
    });

    expect(panel.scrollTop).toBe(20);
    const jumpButton = container.querySelector<HTMLButtonElement>('.act-jump-bottom')!;
    expect(jumpButton).not.toBeNull();

    act(() => {
      jumpButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(panel.scrollTop).toBe(620);
    expect(container.querySelector('.act-jump-bottom')).toBeNull();
  });
});
