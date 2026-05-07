// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const noCwdPlaybook: Playbook = {
  id: 'plain.md',
  name: 'Plain',
  description: 'One shot',
  parameters: [],
  checklist: [],
  tags: [],
  body: 'Do it once.',
  sourceCwd: '/repo',
};

const pinnedCwdPlaybook: Playbook = {
  id: 'pinned.md',
  name: 'Pinned',
  description: 'Has its own cwd',
  parameters: [],
  checklist: [],
  tags: [],
  body: 'Do it in /etc/elsewhere.',
  sourceCwd: '/repo',
  cwd: '/etc/elsewhere',
};

describe('PlaybookBrowser resolved-cwd label', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [noCwdPlaybook, pinnedCwdPlaybook],
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
  });

  function render(onRequestEditCwd?: () => void) {
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/work/myrepo',
          send: () => true,
          onClose: () => {},
          onRequestEditCwd,
        }),
      );
    });
  }

  test('list view shows the dialog cwd with a Change… button', async () => {
    let editRequested = 0;
    render(() => { editRequested += 1; });
    await flush();

    const label = container.querySelector('.playbook-resolved-cwd');
    expect(label).toBeTruthy();
    expect(label!.querySelector('.playbook-resolved-cwd-path')!.textContent).toBe('/work/myrepo');
    expect(label!.querySelector('.playbook-resolved-cwd-override')).toBeNull();

    const changeBtn = label!.querySelector<HTMLButtonElement>('.playbook-resolved-cwd-change');
    expect(changeBtn).toBeTruthy();
    act(() => changeBtn!.click());
    expect(editRequested).toBe(1);
  });

  test('detail view of a playbook with no cwd shows the dialog cwd, no override hint', async () => {
    render();
    await flush();

    const plainCard = Array.from(container.querySelectorAll('.playbook-card'))
      .find((c) => c.textContent?.includes('Plain')) as HTMLElement;
    act(() => plainCard.click());
    await flush();

    const label = container.querySelector('.playbook-resolved-cwd');
    expect(label).toBeTruthy();
    expect(label!.querySelector('.playbook-resolved-cwd-path')!.textContent).toBe('/work/myrepo');
    expect(label!.querySelector('.playbook-resolved-cwd-override')).toBeNull();
  });

  test('detail view of a playbook with cwd shows the override hint instead of Change…', async () => {
    render();
    await flush();

    const pinnedCard = Array.from(container.querySelectorAll('.playbook-card'))
      .find((c) => c.textContent?.includes('Pinned')) as HTMLElement;
    act(() => pinnedCard.click());
    await flush();

    const label = container.querySelector('.playbook-resolved-cwd');
    expect(label).toBeTruthy();
    expect(label!.querySelector('.playbook-resolved-cwd-path')!.textContent).toBe('/etc/elsewhere');

    const override = label!.querySelector('.playbook-resolved-cwd-override');
    expect(override).toBeTruthy();
    expect(override!.textContent).toContain('overridden by playbook');

    expect(label!.querySelector('.playbook-resolved-cwd-change')).toBeNull();
  });

  test('empty state still shows the resolved-cwd label', async () => {
    useKookrStore.setState({ playbooks: [] });
    render();
    await flush();

    expect(container.querySelector('.playbook-resolved-cwd')).toBeTruthy();
    expect(container.querySelector('.playbook-empty')).toBeTruthy();
  });
});
