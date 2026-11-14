// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { LAST_EFFORT_KEY, LAST_MODEL_KEY } from '../store/last-launch-pins.js';
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

const scoutPlaybook: Playbook = {
  id: 'repository-idea-scout.md',
  name: 'Repository Idea Scout',
  description: 'Scout ideas',
  parameters: [],
  checklist: [],
  tags: ['workflow'],
  body: 'Scout.',
  sourceCwd: '/repo',
  scope: 'plugin',
};

describe('PlaybookBrowser effort/model pins', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sent: ClientMessage[];

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [scoutPlaybook],
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    sent = [];
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
  });

  async function openScoutDetail() {
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/repo',
          send: (msg: ClientMessage) => { sent.push(msg); return true; },
          onClose: () => {},
        }),
      );
    });
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((c) => c.textContent?.includes('Repository Idea Scout'))!
        .click();
    });
    await flush();
  }

  function pick(label: string, value: string) {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function submit() {
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  test('sends the selected model and effort and remembers them for the next launch', async () => {
    await openScoutDetail();
    await act(async () => { pick('Model', 'claude-fable-5-2'); });
    await act(async () => { pick('Reasoning effort', 'high'); });
    await submit();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'launchPlaybook',
      playbookPath: 'repository-idea-scout.md',
      agentType: 'claude-code',
      model: 'claude-fable-5-2',
      effort: 'high',
    });
    expect(localStorage.getItem(LAST_MODEL_KEY)).toBe('claude-fable-5-2');
    expect(localStorage.getItem(LAST_EFFORT_KEY)).toBe('high');
  });

  test('omits both pins when left on "Agent default"', async () => {
    await openScoutDetail();
    await submit();

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('model');
    expect(sent[0]).not.toHaveProperty('effort');
  });

  test('restores the last-used pins when the browser opens', async () => {
    localStorage.setItem(LAST_MODEL_KEY, 'claude-fable-5-2');
    localStorage.setItem(LAST_EFFORT_KEY, 'high');
    await openScoutDetail();
    await submit();

    expect(sent[0]).toMatchObject({ model: 'claude-fable-5-2', effort: 'high' });
  });
});
