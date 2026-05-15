// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentEvent } from '../../shared/protocol.js';
import { ActivityPanel } from './ActivityPanel.js';

function userPrompt(prompt: string): AgentEvent {
  return { type: 'user_prompt', sessionId: 's1', prompt };
}

function renderActivity(container: HTMLElement, events: AgentEvent[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ActivityPanel, { events }));
  });
  return root;
}

describe('ActivityPanel paste-burst coalescing (issue #357)', () => {
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

  test('renders a pasted multiline burst as one expandable item, not dozens', () => {
    const lines = Array.from({ length: 43 }, (_, i) => `{"event": ${i}}`);
    root = renderActivity(container, lines.map(userPrompt));

    // One "You" item — not 43 individual user messages.
    expect(container.querySelectorAll('.act-msg-user')).toHaveLength(1);
    const burst = container.querySelector('.act-msg-paste-burst');
    expect(burst).not.toBeNull();

    // Labelled with the line count and detected content kind.
    expect(burst!.querySelector('summary')?.textContent).toContain(
      'Pasted 43 lines of JSON content',
    );

    // The raw lines stay inspectable behind the disclosure.
    const rawLines = burst!.querySelector('.act-paste-burst-lines');
    expect(rawLines?.textContent).toContain('{"event": 0}');
    expect(rawLines?.textContent).toContain('{"event": 42}');
  });

  test('keeps normal separate user messages distinct', () => {
    root = renderActivity(container, [
      userPrompt('first request'),
      { type: 'stop', sessionId: 's1', lastMessage: 'handled the first request' },
      userPrompt('second request'),
    ]);

    // Two ordinary user messages, no coalesced burst.
    expect(container.querySelectorAll('.act-msg-user')).toHaveLength(2);
    expect(container.querySelector('.act-msg-paste-burst')).toBeNull();
    expect(container.textContent).toContain('first request');
    expect(container.textContent).toContain('second request');
  });

  test('the burst detail is collapsed by default and expandable', () => {
    const lines = ['plain line one', 'plain line two', 'plain line three', 'plain line four'];
    root = renderActivity(container, lines.map(userPrompt));

    const details = container.querySelector<HTMLDetailsElement>('details.act-paste-burst');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false); // collapsed until the operator expands it
    expect(details!.querySelector('summary')?.textContent).toContain('Pasted 4 lines');
  });
});
