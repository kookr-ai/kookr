// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage, Playbook } from '../../shared/protocol.js';
import type { ProjectSummary } from '../../shared/protocol.js';

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

const plainPlaybook: Playbook = {
  id: 'plain.md',
  name: 'Plain',
  description: 'One shot',
  parameters: [],
  checklist: [],
  tags: [],
  body: 'Do it once.',
  sourceCwd: '/repo',
  scope: 'project',
};

describe('PlaybookBrowser Repeat (playbook chain) inputs', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sent: ClientMessage[];
  let validity: { iterations: boolean; hours: boolean };

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [plainPlaybook],
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    sent = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('fetch', vi.fn());
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(PlaybookBrowser, {
        cwd: '/repo',
        send: (msg: ClientMessage) => { sent.push(msg); return true; },
        onClose: () => {},
      }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function selectAndSubmit(iterations: string, hours: string) {
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Plain'))!
        .click();
    });
    const iterationsInput = container.querySelector<HTMLInputElement>('input[aria-label="Number of iterations"]')!;
    const hoursInput = container.querySelector<HTMLInputElement>('input[aria-label="Repeat for this many hours"]')!;
    await act(async () => {
      setInputValue(iterationsInput, iterations);
      setInputValue(hoursInput, hours);
    });
    // A raw submit event skips the browser's own constraint validation, so
    // check it explicitly: a real browser would refuse to submit otherwise.
    validity = { iterations: iterationsInput.checkValidity(), hours: hoursInput.checkValidity() };
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  test('accepts whole and half hours in the browser itself', async () => {
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Plain'))!
        .click();
    });
    const hoursInput = container.querySelector<HTMLInputElement>('input[aria-label="Repeat for this many hours"]')!;
    for (const hours of ['6', '8', '0.5', '1.5', '168']) {
      await act(async () => { setInputValue(hoursInput, hours); });
      expect(hoursInput.checkValidity(), hours).toBe(true);
    }
  });

  test('sends the chain bounds with the launch when Repeat is filled in', async () => {
    await selectAndSubmit('4', '6');
    expect(validity).toEqual({ iterations: true, hours: true });
    expect(sent).toEqual([expect.objectContaining({
      type: 'launchPlaybook',
      playbookPath: 'plain.md',
      chain: { maxIterations: 4, durationMinutes: 360 },
    })]);
  });

  test('launches a single run when Repeat is left empty', async () => {
    await selectAndSubmit('', '');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('chain');
  });

  test('refuses an invalid iteration count instead of launching', async () => {
    await selectAndSubmit('0', '');
    expect(sent).toEqual([]);
  });
});
