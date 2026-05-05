// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage, Playbook } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const loopablePlaybook: Playbook = {
  id: 'workflow.md',
  name: 'Workflow',
  description: 'Loop-compatible workflow',
  parameters: [],
  checklist: [],
  tags: ['workflow', 'loopable'],
  effectiveLoop: {
    iterationCap: 6,
    costCapUsd: 5,
    sources: {
      iterationCap: 'default',
      costCapUsd: 'default',
    },
  },
  body: 'Do it.',
  sourceCwd: '/repo',
};

const plainPlaybook: Playbook = {
  id: 'plain.md',
  name: 'Plain',
  description: 'One shot',
  parameters: [],
  checklist: [],
  tags: [],
  body: 'Do it once.',
  sourceCwd: '/repo',
};

describe('PlaybookBrowser loopable workflows', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sent: ClientMessage[];
  let closeCount: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [loopablePlaybook, plainPlaybook],
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    sent = [];
    closeCount = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/repo',
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test('renders loopable tag as a badge on the playbook card', async () => {
    await flush();

    // The loopable playbook card should show both 'workflow' and 'loopable' badges
    const cards = container.querySelectorAll('.playbook-card');
    const workflowCard = Array.from(cards).find((c) => c.textContent?.includes('Workflow'));
    expect(workflowCard).toBeTruthy();
    expect(workflowCard!.querySelector('.playbook-tag-loopable')).toBeTruthy();
    expect(workflowCard!.querySelector('.playbook-tag-workflow')).toBeTruthy();

    // The plain playbook should not show any tag badges
    const plainCard = Array.from(cards).find((c) => c.textContent?.includes('Plain'));
    expect(plainCard).toBeTruthy();
    expect(plainCard!.querySelector('.playbook-tag-loopable')).toBeNull();
  });

  test('shows loopable filter button with correct count', async () => {
    await flush();

    const filterBtn = container.querySelector<HTMLButtonElement>('.playbook-filter');
    expect(filterBtn).toBeTruthy();
    expect(filterBtn!.textContent).toContain('Loopable workflows (1)');
  });

  test('filter button shows only loopable playbooks when active', async () => {
    await flush();

    // Before filtering: both playbooks visible
    expect(container.textContent).toContain('Workflow');
    expect(container.textContent).toContain('Plain');

    // Activate filter
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.playbook-filter')!.click();
    });

    // Only loopable playbook should appear
    expect(container.textContent).toContain('Workflow');
    expect(container.textContent).not.toContain('Plain');
  });

  test('filter combined with search hides non-matching loopable playbooks', async () => {
    await flush();

    // Activate loopable filter first
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.playbook-filter')!.click();
    });

    // Search for something that matches only the plain playbook
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('.playbook-search-input')!, 'Plain');
    });

    // No cards should appear because 'Plain' is not loopable
    expect(container.querySelector('.playbook-card')).toBeNull();
  });

  test('shows validation message for non-loopable playbook when looped mode would apply', async () => {
    await flush();

    // Click into the plain (non-loopable) playbook detail
    await act(async () => {
      const cards = container.querySelectorAll<HTMLElement>('.playbook-card');
      const plainCard = Array.from(cards).find((c) => c.textContent?.includes('Plain'));
      plainCard!.click();
    });

    // The "Run looped" button should be disabled
    const loopedBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
      .find((btn) => btn.textContent === 'Run looped');
    expect(loopedBtn).toBeTruthy();
    expect(loopedBtn!.disabled).toBe(true);

    // The validation message should be visible
    expect(container.textContent).toContain('Looping unavailable: this playbook is not tagged loopable.');
  });

  test('loopable tag badge shown in detail view header', async () => {
    await flush();

    // Click into the loopable playbook
    await act(async () => {
      const cards = container.querySelectorAll<HTMLElement>('.playbook-card');
      const workflowCard = Array.from(cards).find((c) => c.textContent?.includes('Workflow'));
      workflowCard!.click();
    });

    // The detail header should show the loopable tag badge
    expect(container.querySelector('.playbook-tag-loopable')).toBeTruthy();
  });

  test('launches loopable playbooks through the looped endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'task-1' }),
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((button) => button.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sent).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/playbooks/ralph-loop', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'ui' },
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      playbookPath: 'workflow.md',
      cwd: '/repo',
      parameterValues: {},
    });
    expect(closeCount).toBe(1);
  });
});
