// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PluginInstallBanner, PLUGIN_INSTALL_DISMISS_KEY } from './PluginInstallBanner.js';

interface PluginPayload {
  pluginId: string;
  installedVersion: string | null;
  availableVersion: string | null;
  stale: boolean;
}

function mockDeployStatus(plugin: PluginPayload | undefined): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => (plugin ? { plugin } : {}) })),
  );
}

async function mountAndFlush(root: Root): Promise<void> {
  await act(async () => {
    root.render(React.createElement(PluginInstallBanner));
  });
  // Let the on-mount fetch + json() promise chain settle, then re-render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('PluginInstallBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  test('renders the install nudge with both commands when the plugin is not installed', async () => {
    mockDeployStatus({ pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: '0.7.4', stale: false });
    await mountAndFlush(root);

    const banner = container.querySelector('.plugin-install-banner');
    expect(banner).not.toBeNull();
    const text = banner?.textContent ?? '';
    expect(text).toContain('/plugin marketplace add kookr-ai/kookr');
    expect(text).toContain('/plugin install kookr-toolkit@kookr');
  });

  test('stays silent when the plugin is already installed', async () => {
    mockDeployStatus({ pluginId: 'kookr-toolkit@kookr', installedVersion: '0.7.4', availableVersion: '0.7.4', stale: false });
    await mountAndFlush(root);
    expect(container.querySelector('.plugin-install-banner')).toBeNull();
  });

  test('stays silent when the deploy status carries no plugin field', async () => {
    mockDeployStatus(undefined);
    await mountAndFlush(root);
    expect(container.querySelector('.plugin-install-banner')).toBeNull();
  });

  test('does not render when previously dismissed (localStorage), and does not even fetch', async () => {
    window.localStorage.setItem(PLUGIN_INSTALL_DISMISS_KEY, '1');
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchSpy);
    await mountAndFlush(root);
    expect(container.querySelector('.plugin-install-banner')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('dismiss hides the banner and persists the flag', async () => {
    mockDeployStatus({ pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: '0.7.4', stale: false });
    await mountAndFlush(root);

    const dismissBtn = container.querySelector('.toast-dismiss') as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();
    await act(async () => {
      dismissBtn?.click();
    });

    expect(container.querySelector('.plugin-install-banner')).toBeNull();
    expect(window.localStorage.getItem(PLUGIN_INSTALL_DISMISS_KEY)).toBe('1');
  });
});
