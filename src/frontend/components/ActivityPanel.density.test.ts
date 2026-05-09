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
});
