// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { LAUNCH_TASK_DIALOG_DRAFT_KEY } from '../store/launch-task-dialog-draft.js';
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

function getCwdEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('.combo-input input[type="text"]');
  if (!el) throw new Error('cwd input not rendered');
  return el as HTMLInputElement;
}

/**
 * Read the resolved cwd from whichever surface is currently rendered. When
 * projectContext is set the dialog opens on the playbooks tab and renders the
 * resolved-cwd label; without projectContext it opens on the manual tab and
 * renders the cwd input. Both reflect the same underlying state.
 */
function getResolvedCwd(container: HTMLElement): string {
  const labelPath = container.querySelector('.playbook-resolved-cwd-path');
  if (labelPath) return labelPath.textContent ?? '';
  return getCwdEl(container).value;
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

function renderDialog(
  container: HTMLElement,
  props: { projectContext?: ProjectSummary; defaultCwd?: string; expectedCwd?: string } = {},
): { root: Root } {
  // Pre-populate the playbook fetch cache so the dialog's mount effect does
  // not flip playbooksLoading to true (which hides the resolved-cwd label).
  if (props.expectedCwd) {
    useKookrStore.setState({
      playbooksLastFetchedCwd: props.expectedCwd,
      playbooksLastFetchedAt: Date.now(),
    });
  }
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (_msg: ClientMessage) => true,
        onClose: () => {},
        projectContext: props.projectContext,
        defaultCwd: props.defaultCwd,
      }),
    );
  });
  return { root };
}

describe('LaunchTaskDialog projectContext.localPath', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    // Stub playbooks state so PlaybookBrowser does not enter the loading
    // branch — the resolved-cwd label only renders in list/detail/empty
    // views, not during loading. The dialog's mount-effect re-fires
    // listPlaybooks unless the cache looks fresh: same cwd, recent fetch,
    // AND playbooks.length > 0. So we provide a single stub playbook that
    // also exercises the "list view" branch where the label is rendered.
    useKookrStore.setState({
      serverCwd: '/server/cwd',
      sttUrl: '',
      playbooks: [
        {
          id: 'stub.md',
          name: 'Stub',
          description: '',
          parameters: [],
          checklist: [],
          tags: [],
          body: '',
          sourceCwd: '/work/grafana',
        } as any,
      ],
      playbooksLoading: false,
      playbooksLastFetchedAt: Date.now(),
      playbooksLastFetchedCwd: '/work/grafana',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('pre-fills cwd with projectContext.localPath when set', async () => {
    const { root } = renderDialog(container, {
      projectContext: makeProjectContext('/work/grafana'),
      expectedCwd: '/work/grafana',
    });
    await flush();

    expect(getResolvedCwd(container)).toBe('/work/grafana');

    act(() => root.unmount());
  });

  test('projectContext.localPath overrides a persisted draft cwd', async () => {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ prompt: 'pending', cwd: '/old/draft/path', criteria: '' }),
    );

    const { root } = renderDialog(container, {
      projectContext: makeProjectContext('/work/grafana'),
      expectedCwd: '/work/grafana',
    });
    await flush();

    expect(getResolvedCwd(container)).toBe('/work/grafana');

    act(() => root.unmount());
  });

  test('without projectContext, draft cwd is restored as before', async () => {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ prompt: 'pending', cwd: '/old/draft/path', criteria: '' }),
    );

    const { root } = renderDialog(container);
    await flush();

    expect(getResolvedCwd(container)).toBe('/old/draft/path');

    act(() => root.unmount());
  });

  test('projectContext without localPath falls through to draft/MRU/serverCwd', async () => {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ prompt: 'pending', cwd: '/old/draft/path', criteria: '' }),
    );

    const { root } = renderDialog(container, {
      projectContext: makeProjectContext(),
      expectedCwd: '/old/draft/path',
    });
    await flush();

    expect(getResolvedCwd(container)).toBe('/old/draft/path');

    act(() => root.unmount());
  });

  test('defaultCwd (relaunch) still wins over projectContext.localPath', async () => {
    const { root } = renderDialog(container, {
      projectContext: makeProjectContext('/work/grafana'),
      defaultCwd: '/relaunch/path',
      expectedCwd: '/relaunch/path',
    });
    await flush();

    expect(getResolvedCwd(container)).toBe('/relaunch/path');

    act(() => root.unmount());
  });
});
