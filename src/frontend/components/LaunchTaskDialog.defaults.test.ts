// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { LAUNCH_TASK_DIALOG_DRAFT_KEY } from '../store/launch-task-dialog-draft.js';
import { LAST_AGENT_TYPE_KEY } from '../store/last-agent-type.js';
import type { ClientMessage, ProjectSummary } from '../../shared/protocol.js';

const RECENT_PATHS_KEY = 'kookr:recentPaths';

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

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function getPromptEl(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not rendered');
  return el as HTMLTextAreaElement;
}

function getCwdEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('.combo-input input[type="text"]');
  if (!el) throw new Error('cwd input not rendered');
  return el as HTMLInputElement;
}

function getAgentSelectEl(container: HTMLElement): HTMLSelectElement {
  const el = container.querySelector('.agent-type-select select');
  if (!el) throw new Error('agent select not rendered');
  return el as HTMLSelectElement;
}

function mkProject(overrides: Partial<ProjectSummary> & { project: string; displayName: string }): ProjectSummary {
  return {
    color: 1,
    activeAgents: 0,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openPrs: 0,
    recentTasks: [],
    ...overrides,
  };
}

function renderDialog(
  container: HTMLElement,
  props: { defaultAgentType?: 'claude-code' | 'codex-cli' } = {},
): { root: Root; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (msg: ClientMessage) => { sent.push(msg); return true; },
        onClose: () => {},
        defaultAgentType: props.defaultAgentType,
      }),
    );
  });
  return { root, sent };
}

describe('LaunchTaskDialog cwd default chain and dropdown (RFC F13)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/srv/kookr-prod', sttUrl: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('MRU most-recent path beats tracked project path and serverCwd', async () => {
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(['/work/recent', '/work/older']));
    useKookrStore.setState({
      projectSummaries: [mkProject({ project: 'github.com/acme/a', displayName: 'acme/a', localPath: '/work/acme-a' })],
    });

    const { root } = renderDialog(container);
    await flush();

    expect(getCwdEl(container).value).toBe('/work/recent');
    act(() => root.unmount());
  });

  test('first tracked project localPath beats serverCwd when MRU is empty', async () => {
    useKookrStore.setState({
      projectSummaries: [
        mkProject({ project: 'github.com/acme/a', displayName: 'acme/a', localPath: '/work/acme-a' }),
        mkProject({ project: 'github.com/acme/b', displayName: 'acme/b', localPath: '/work/acme-b' }),
      ],
    });

    const { root } = renderDialog(container);
    await flush();

    expect(getCwdEl(container).value).toBe('/work/acme-a');
    act(() => root.unmount());
  });

  test('serverCwd is the last resort and shows the runtime-checkout hint', async () => {
    const { root } = renderDialog(container);
    await flush();

    expect(getCwdEl(container).value).toBe('/srv/kookr-prod');
    expect(container.querySelector('.cwd-server-hint')?.textContent).toContain("Kookr's own runtime checkout");
    act(() => root.unmount());
  });

  test('no hint when the cwd is not the server runtime checkout', async () => {
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(['/work/recent']));

    const { root } = renderDialog(container);
    await flush();

    expect(container.querySelector('.cwd-server-hint')).toBeNull();
    act(() => root.unmount());
  });

  test('draft cwd still beats MRU and project paths', async () => {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ prompt: 'pending', cwd: '/draft/path', criteria: '' }),
    );
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(['/work/recent']));
    useKookrStore.setState({
      projectSummaries: [mkProject({ project: 'github.com/acme/a', displayName: 'acme/a', localPath: '/work/acme-a' })],
    });

    const { root } = renderDialog(container);
    await flush();

    expect(getCwdEl(container).value).toBe('/draft/path');
    act(() => root.unmount());
  });

  test('dropdown merges tracked project paths (labeled) after MRU entries, deduped by path', async () => {
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(['/work/recent', '/work/acme-a']));
    useKookrStore.setState({
      projectSummaries: [
        mkProject({ project: 'github.com/acme/a', displayName: 'acme/a', localPath: '/work/acme-a' }),
        mkProject({ project: 'github.com/acme/b', displayName: 'acme/b', localPath: '/work/acme-b' }),
        mkProject({ project: 'github.com/acme/c', displayName: 'acme/c' }), // no localPath — excluded
      ],
    });

    const { root } = renderDialog(container);
    await flush();

    // Clear the field so all suggestions show, then focus to open the dropdown.
    const cwdEl = getCwdEl(container);
    await act(async () => { setInputValue(cwdEl, ''); });
    await act(async () => { cwdEl.dispatchEvent(new Event('focus', { bubbles: true })); });
    await flush();

    const items = Array.from(container.querySelectorAll('.combo-dropdown li'));
    expect(items.map((li) => li.textContent)).toEqual([
      '/work/recent',
      '/work/acme-aacme/a', // MRU slot kept, project label appended
      '/work/acme-bacme/b',
    ]);
    expect(items[0].querySelector('.combo-dropdown-project')).toBeNull();
    expect(items[1].querySelector('.combo-dropdown-project')?.textContent).toBe('acme/a');
    expect(items[2].querySelector('.combo-dropdown-project')?.textContent).toBe('acme/b');
    act(() => root.unmount());
  });

  test('dropdown filter matches project display names, not just paths', async () => {
    useKookrStore.setState({
      projectSummaries: [
        mkProject({ project: 'github.com/acme/widgets', displayName: 'acme/widgets', localPath: '/checkouts/w' }),
        mkProject({ project: 'github.com/acme/gears', displayName: 'acme/gears', localPath: '/checkouts/g' }),
      ],
    });

    const { root } = renderDialog(container);
    await flush();

    const cwdEl = getCwdEl(container);
    await act(async () => { setInputValue(cwdEl, 'widgets'); });
    await flush();

    const items = Array.from(container.querySelectorAll('.combo-dropdown li'));
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('/checkouts/w');
    act(() => root.unmount());
  });
});

describe('LaunchTaskDialog agent default chain (RFC F6)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/tmp/work', sttUrl: '', defaultAgentType: 'codex-cli' });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('last-used agent beats the server default', async () => {
    localStorage.setItem(LAST_AGENT_TYPE_KEY, 'claude-code');

    const { root } = renderDialog(container);
    await flush();

    expect(getAgentSelectEl(container).value).toBe('claude-code');
    act(() => root.unmount());
  });

  test('falls back to the server default when nothing was persisted', async () => {
    const { root } = renderDialog(container);
    await flush();

    expect(getAgentSelectEl(container).value).toBe('codex-cli');
    act(() => root.unmount());
  });

  test('explicit defaultAgentType prop beats the persisted last-used agent', async () => {
    localStorage.setItem(LAST_AGENT_TYPE_KEY, 'claude-code');

    const { root } = renderDialog(container, { defaultAgentType: 'codex-cli' });
    await flush();

    expect(getAgentSelectEl(container).value).toBe('codex-cli');
    act(() => root.unmount());
  });

  test('an unknown persisted value is ignored', async () => {
    localStorage.setItem(LAST_AGENT_TYPE_KEY, 'gpt-cli');

    const { root } = renderDialog(container);
    await flush();

    expect(getAgentSelectEl(container).value).toBe('codex-cli');
    act(() => root.unmount());
  });

  test('successful submit persists the selected agent as last-used', async () => {
    const { root } = renderDialog(container);
    await flush();

    const select = getAgentSelectEl(container);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'claude-code');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { setInputValue(getPromptEl(container), 'do the thing'); });
    await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
    await flush();

    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();

    expect(localStorage.getItem(LAST_AGENT_TYPE_KEY)).toBe('claude-code');
    act(() => root.unmount());
  });
});
