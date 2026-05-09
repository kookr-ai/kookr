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

function renderDialog(
  container: HTMLElement,
  props: { projectCwd?: string; defaultCwd?: string; projectContext?: ProjectSummary; send?: (msg: ClientMessage) => boolean } = {},
): { root: Root } {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: props.send ?? ((_msg: ClientMessage) => true),
        onClose: () => {},
        projectCwd: props.projectCwd,
        defaultCwd: props.defaultCwd,
        projectContext: props.projectContext,
      }),
    );
  });
  return { root };
}

const projectSummary: ProjectSummary = {
  project: 'github.com/acme/target',
  displayName: 'acme/target',
  color: 1,
  activeAgents: 0,
  findingCount: 0,
  todayPrCount: 0,
  weekPrCount: 0,
  openPrs: 0,
  recentTasks: [],
};

describe('LaunchTaskDialog projectCwd prop', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/server/cwd', sttUrl: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('pre-fills cwd with projectCwd when provided', async () => {
    const { root } = renderDialog(container, { projectCwd: '/work/grafana' });
    await flush();

    expect(getCwdEl(container).value).toBe('/work/grafana');

    act(() => root.unmount());
  });

  test('projectCwd overrides a persisted draft cwd', async () => {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ prompt: 'pending', cwd: '/old/draft/path', criteria: '' }),
    );

    const { root } = renderDialog(container, { projectCwd: '/work/grafana' });
    await flush();

    expect(getCwdEl(container).value).toBe('/work/grafana');

    act(() => root.unmount());
  });

  test('without projectCwd, draft cwd is restored as before', async () => {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ prompt: 'pending', cwd: '/old/draft/path', criteria: '' }),
    );

    const { root } = renderDialog(container);
    await flush();

    expect(getCwdEl(container).value).toBe('/old/draft/path');

    act(() => root.unmount());
  });

  test('defaultCwd (relaunch) still wins over projectCwd', async () => {
    const { root } = renderDialog(container, {
      projectCwd: '/work/grafana',
      defaultCwd: '/relaunch/path',
    });
    await flush();

    expect(getCwdEl(container).value).toBe('/relaunch/path');

    act(() => root.unmount());
  });

  test('project context lists playbooks from server cwd and keeps unresolved target empty', async () => {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ prompt: 'pending', cwd: '/old/draft/path', criteria: '' }),
    );
    const sent: ClientMessage[] = [];
    const { root } = renderDialog(container, {
      projectCwd: '',
      projectContext: projectSummary,
      send: (msg) => {
        sent.push(msg);
        return true;
      },
    });
    await flush();
    await act(async () => {
      useKookrStore.setState({
        playbooksLoading: false,
        playbooks: [],
        playbooksLastFetchedCwd: '/server/cwd',
        playbooksLastFetchedAt: Date.now(),
      });
    });
    await flush();

    expect(sent).toContainEqual({ type: 'listPlaybooks', cwd: '/server/cwd' });
    expect(container.textContent).toContain('Running in:');
    expect(container.textContent).toContain('Playbooks from:');
    expect(container.textContent).toContain('/server/cwd');
    expect(container.textContent).not.toContain('/old/draft/path');
    expect(Array.from(container.querySelectorAll('.playbook-resolved-cwd-path')).map((el) => el.textContent)).toEqual(['/server/cwd', '']);

    act(() => root.unmount());
  });
});
