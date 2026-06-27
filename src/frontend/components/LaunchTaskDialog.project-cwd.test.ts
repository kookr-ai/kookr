// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { LAUNCH_TASK_DIALOG_DRAFT_KEY } from '../store/launch-task-dialog-draft.js';
import type { ClientMessage } from '../../shared/protocol.js';
import type { ProjectSummary } from '../../shared/protocol.js';

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
  props: {
    projectCwd?: string;
    defaultCwd?: string;
    projectContext?: ProjectSummary;
    initialTab?: 'manual' | 'playbooks';
    send?: (msg: ClientMessage) => boolean;
  } = {},
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
        initialTab: props.initialTab,
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
  openContributionAttempts: 0,
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

  // Empty/unresolved project cwd (deriveLaunchProjectCwd can return '' or null):
  // the catalog must fall back to serverCwd, never scan `<empty>/.kookr/...`.
  // The execution cwd (getTaskTargetCwd) stays empty here — unchanged by #1019.
  test('project context with empty cwd falls back to server cwd for the catalog and keeps the target empty', async () => {
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
    // [catalog, target]: catalog falls back to serverCwd, target stays empty.
    expect(Array.from(container.querySelectorAll('.playbook-resolved-cwd-path')).map((el) => el.textContent)).toEqual(['/server/cwd', '']);
    const playbooksTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.dialog-tab'))
      .find((button) => button.textContent === 'Playbooks');
    expect(document.activeElement).toBe(playbooksTab);

    act(() => root.unmount());
  });

  // The null branch of deriveLaunchProjectCwd surfaces as a missing projectCwd
  // prop (App passes `deriveLaunchProjectCwd(...) ?? ''`, but the prop itself is
  // `string | undefined`). With no project cwd and no draft/recent/tracked path,
  // the catalog must still resolve to serverCwd, never `<undefined>/.kookr/...`.
  test('project context with no project cwd falls back to server cwd for the catalog', async () => {
    const sent: ClientMessage[] = [];
    const { root } = renderDialog(container, {
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
    // Catalog and execution cwd both resolve to serverCwd, so the resolved-cwd
    // line collapses to the single "Running in:" serverCwd path.
    expect(Array.from(container.querySelectorAll('.playbook-resolved-cwd-path')).map((el) => el.textContent)).toEqual(['/server/cwd']);

    act(() => root.unmount());
  });

  // Core #1019 behavior: a project-focused launch lists THAT project's catalog
  // cwd, while the execution cwd (getTaskTargetCwd) stays the project cwd —
  // unchanged from the catalog/target split of #209.
  test('project context lists the focused project catalog cwd and runs in the project cwd', async () => {
    const sent: ClientMessage[] = [];
    const { root } = renderDialog(container, {
      projectCwd: '/work/grafana',
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
        playbooksLastFetchedCwd: '/work/grafana',
        playbooksLastFetchedAt: Date.now(),
      });
    });
    await flush();

    // Catalog query targets the project, not serverCwd.
    expect(sent).toContainEqual({ type: 'listPlaybooks', cwd: '/work/grafana' });
    expect(sent).not.toContainEqual({ type: 'listPlaybooks', cwd: '/server/cwd' });
    // Catalog source now coincides with the execution cwd, so PlaybookBrowser
    // collapses to the single "Running in:" line (no separate "Playbooks from:"
    // tier). The lone resolved path is the project's execution cwd — unchanged.
    expect(container.textContent).toContain('Running in:');
    expect(container.textContent).not.toContain('Playbooks from:');
    expect(Array.from(container.querySelectorAll('.playbook-resolved-cwd-path')).map((el) => el.textContent)).toEqual(['/work/grafana']);

    act(() => root.unmount());
  });

  // No-project ("+ Launch") behavior is unchanged: with no typed cwd the catalog
  // falls back to serverCwd. (getPlaybookSourceCwd never special-cased the
  // no-project case, so this guards against regressing the fallback.)
  test('without a project, switching to playbooks lists the server cwd catalog', async () => {
    const sent: ClientMessage[] = [];
    const { root } = renderDialog(container, {
      send: (msg) => {
        sent.push(msg);
        return true;
      },
    });
    await flush();

    // No mount-time fetch without a project; the dialog opens on Manual.
    expect(sent).toEqual([]);
    const playbooksTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.dialog-tab'))
      .find((button) => button.textContent === 'Playbooks');
    if (!playbooksTab) throw new Error('Playbooks tab not rendered');
    await act(async () => {
      playbooksTab.click();
    });
    await flush();

    expect(sent).toContainEqual({ type: 'listPlaybooks', cwd: '/server/cwd' });

    act(() => root.unmount());
  });

  test('project context can open directly to manual without listing playbooks', async () => {
    const sent: ClientMessage[] = [];
    const { root } = renderDialog(container, {
      projectCwd: '/work/grafana',
      projectContext: projectSummary,
      initialTab: 'manual',
      send: (msg) => {
        sent.push(msg);
        return true;
      },
    });
    await flush();

    expect(sent).toEqual([]);
    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Manual');
    expect(getCwdEl(container).value).toBe('/work/grafana');

    act(() => root.unmount());
  });

  test('project context manual launch with unknown cwd keeps cwd blank', async () => {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ prompt: 'pending', cwd: '/old/draft/path', criteria: '' }),
    );
    const { root } = renderDialog(container, {
      projectCwd: '',
      projectContext: projectSummary,
      initialTab: 'manual',
    });
    await flush();

    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Manual');
    expect(getCwdEl(container).value).toBe('');
    expect(container.textContent).not.toContain('/old/draft/path');

    act(() => root.unmount());
  });
});
