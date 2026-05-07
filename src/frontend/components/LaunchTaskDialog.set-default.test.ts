// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage } from '../../shared/protocol.js';
import type { ProjectSummary } from '../../core/project-summary.js';

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

function makeProjectContext(localPath?: string): ProjectSummary {
  return {
    project: 'github.com/grafana/grafana',
    displayName: 'grafana/grafana',
    color: 0,
    activeAgents: 0,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openPrs: 0,
    recentTasks: [],
    ...(localPath !== undefined ? { localPath } : {}),
  };
}

describe('LaunchTaskDialog "Set as default for this project" checkbox', () => {
  let container: HTMLDivElement;
  let sent: ClientMessage[];

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/server/cwd',
      sttUrl: '',
      playbooks: [],
      playbooksLoading: false,
      playbooksLastFetchedAt: Date.now(),
      playbooksLastFetchedCwd: '/work/grafana-fork',
    });
    sent = [];
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  function render(projectContext: ProjectSummary | undefined): Root {
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(LaunchTaskDialog, {
          send: (msg: ClientMessage) => { sent.push(msg); return true; },
          onClose: () => {},
          projectContext,
        }),
      );
    });
    return root;
  }

  test('checkbox is hidden when cwd matches projectContext.localPath', async () => {
    // Default cwd resolution will pick projectContext.localPath since no draft.
    const root = render(makeProjectContext('/work/grafana-fork'));
    await flush();

    expect(container.querySelector('.set-as-project-default')).toBeNull();
    act(() => root.unmount());
  });

  test('checkbox is hidden when no projectContext is supplied', async () => {
    const root = render(undefined);
    await flush();

    expect(container.querySelector('.set-as-project-default')).toBeNull();
    act(() => root.unmount());
  });

  test('checkbox is visible when cwd differs from projectContext.localPath', async () => {
    // localPath set to a value different from playbooksLastFetchedCwd, so the
    // dialog will pick localPath as initial cwd. Make them differ to surface
    // the checkbox: localPath is /work/grafana-fork, but we need cwd != it.
    // Use makeProjectContext with localPath that differs from cache.
    useKookrStore.setState({ playbooksLastFetchedCwd: '/work/grafana' });
    const root = render(makeProjectContext('/work/grafana'));
    await flush();

    // Force cwd != localPath by typing into the input. First switch to the
    // manual tab so the input is rendered.
    const manualTabBtn = Array.from(container.querySelectorAll('.dialog-tab'))
      .find((b) => b.textContent === 'Manual') as HTMLButtonElement | undefined;
    expect(manualTabBtn).toBeTruthy();
    act(() => manualTabBtn!.click());
    await flush();

    const cwdInput = container.querySelector<HTMLInputElement>('.combo-input input[type="text"]');
    expect(cwdInput).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(cwdInput!, '/work/grafana-different-clone');
      cwdInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('.set-as-project-default')).toBeTruthy();
    act(() => root.unmount());
  });

  test('launch with checkbox unchecked omits updateProjectLocalPath', async () => {
    const root = render(makeProjectContext('/work/grafana'));
    await flush();

    const manualTabBtn = Array.from(container.querySelectorAll('.dialog-tab'))
      .find((b) => b.textContent === 'Manual') as HTMLButtonElement;
    act(() => manualTabBtn.click());
    await flush();

    const promptInput = container.querySelector<HTMLTextAreaElement>('textarea');
    const cwdInput = container.querySelector<HTMLInputElement>('.combo-input input[type="text"]')!;
    act(() => {
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const taSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      taSetter.call(promptInput!, 'do the thing');
      promptInput!.dispatchEvent(new Event('input', { bubbles: true }));
      inputSetter.call(cwdInput, '/work/different');
      cwdInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent === 'Launch') as HTMLButtonElement;
    expect(submitBtn).toBeTruthy();
    act(() => submitBtn.click());
    await flush();

    const launchMsg = sent.find((m) => m.type === 'launch') as
      | (ClientMessage & { type: 'launch'; updateProjectLocalPath?: boolean })
      | undefined;
    expect(launchMsg).toBeTruthy();
    expect(launchMsg!.updateProjectLocalPath).toBeUndefined();

    act(() => root.unmount());
  });

  test('launch with checkbox checked sends updateProjectLocalPath: true', async () => {
    const root = render(makeProjectContext('/work/grafana'));
    await flush();

    const manualTabBtn = Array.from(container.querySelectorAll('.dialog-tab'))
      .find((b) => b.textContent === 'Manual') as HTMLButtonElement;
    act(() => manualTabBtn.click());
    await flush();

    const promptInput = container.querySelector<HTMLTextAreaElement>('textarea');
    const cwdInput = container.querySelector<HTMLInputElement>('.combo-input input[type="text"]')!;
    act(() => {
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const taSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      taSetter.call(promptInput!, 'do the thing');
      promptInput!.dispatchEvent(new Event('input', { bubbles: true }));
      inputSetter.call(cwdInput, '/work/different');
      cwdInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const checkbox = container.querySelector<HTMLInputElement>('.set-as-project-default input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    act(() => checkbox!.click());
    await flush();

    const submitBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent === 'Launch') as HTMLButtonElement;
    act(() => submitBtn.click());
    await flush();

    const launchMsg = sent.find((m) => m.type === 'launch') as
      | (ClientMessage & { type: 'launch'; updateProjectLocalPath?: boolean })
      | undefined;
    expect(launchMsg).toBeTruthy();
    expect(launchMsg!.updateProjectLocalPath).toBe(true);

    act(() => root.unmount());
  });
});
