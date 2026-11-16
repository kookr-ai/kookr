// @vitest-environment happy-dom

/**
 * The Settings deep links (#4022): the usage footer's quota line and the
 * capacity controls each open Settings on their own field. The openers live in
 * App, so these tests render App, call the callback each component received,
 * and read which field the Settings dialog was asked to focus.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';

type Callback = (() => void) | undefined;

const captured = vi.hoisted(() => ({
  usage: new Map<string, { onOpenQuotaSettings: (() => void) | undefined }>(),
  sidebar: { onAdjustCap: undefined as (() => void) | undefined },
  topBar: { onOpenCapacity: undefined as (() => void) | undefined },
}));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ send: () => true }),
}));

vi.mock('./hooks/useNotifications.js', () => ({
  useNotifications: () => {},
}));

vi.mock('./hooks/useAudibleAlert.js', () => ({
  useAudibleAlert: () => {},
}));

vi.mock('./hooks/useTaskCompletionChime.js', () => ({
  useTaskCompletionChime: () => {},
}));

vi.mock('./telemetry.js', () => ({
  track: vi.fn(),
}));

vi.mock('./components/DetailPanel.js', () => ({
  DetailPanel: () => React.createElement('div', { 'data-testid': 'detail-panel' }),
}));

vi.mock('./components/UsageSummary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./components/UsageSummary.js')>()),
  UsageSummary: (props: { placement: string; onOpenQuotaSettings?: () => void }) => {
    captured.usage.set(props.placement, { onOpenQuotaSettings: props.onOpenQuotaSettings });
    return React.createElement('div', { 'data-testid': `usage-${props.placement}` });
  },
}));

vi.mock('./components/ProjectSidebar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./components/ProjectSidebar.js')>()),
  ProjectSidebar: (props: { onAdjustCap?: () => void; footer?: React.ReactNode }) => {
    captured.sidebar.onAdjustCap = props.onAdjustCap;
    return React.createElement('nav', { 'data-testid': 'project-sidebar' }, props.footer);
  },
}));

vi.mock('./components/TopBar.js', () => ({
  TopBar: (props: { onOpenCapacity?: () => void; usage?: React.ReactNode }) => {
    captured.topBar.onOpenCapacity = props.onOpenCapacity;
    return React.createElement('header', { 'data-testid': 'top-bar' }, props.usage);
  },
}));

vi.mock('./components/SettingsDialog.js', () => ({
  SettingsDialog: (props: { focusField?: string; onClose: () => void }) => React.createElement(
    'div',
    { 'data-testid': 'settings-dialog', 'data-focus-field': props.focusField ?? '' },
    React.createElement('button', { type: 'button', 'data-testid': 'settings-close', onClick: props.onClose }, 'Close'),
  ),
}));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('App Settings deep links', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    captured.usage.clear();
    captured.sidebar.onAdjustCap = undefined;
    captured.topBar.onOpenCapacity = undefined;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response)));
    syncGlobalStore();
    useKookrStore.setState({ connected: true, projectSummariesHydrated: true, sttUrl: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  function dialog(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-testid="settings-dialog"]');
  }

  async function open(callback: Callback): Promise<string | null> {
    expect(callback, 'App passed the opener down').toBeTypeOf('function');
    await act(async () => {
      callback!();
    });
    // The dialog is lazy-loaded: wait for the chunk, then for the render.
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    return dialog()!.getAttribute('data-focus-field');
  }

  async function close(): Promise<void> {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-close"]')!.click();
    });
    expect(dialog()).toBeNull();
  }

  test('the quota line in the navigation footer opens Settings on the quota headroom field', async () => {
    expect(await open(captured.usage.get('nav')?.onOpenQuotaSettings)).toBe('quotaHeadroomThreshold');
  });

  test('the quota line in the System usage section opens Settings on the quota headroom field', async () => {
    expect(await open(captured.usage.get('system')?.onOpenQuotaSettings)).toBe('quotaHeadroomThreshold');
  });

  test('the sidebar capacity control opens Settings on the active-task limit', async () => {
    expect(await open(captured.sidebar.onAdjustCap)).toBe('maxActiveTasks');
  });

  test('the top bar capacity control opens Settings on the active-task limit', async () => {
    expect(await open(captured.topBar.onOpenCapacity)).toBe('maxActiveTasks');
  });

  test('after one deep link is closed, the next opens Settings on its own field', async () => {
    expect(await open(captured.usage.get('nav')?.onOpenQuotaSettings)).toBe('quotaHeadroomThreshold');
    await close();
    expect(await open(captured.sidebar.onAdjustCap)).toBe('maxActiveTasks');
  });
});
