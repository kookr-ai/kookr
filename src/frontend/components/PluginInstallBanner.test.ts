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
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/deploy/status')) {
        return { ok: true, json: async () => (plugin ? { plugin } : {}) };
      }
      return { ok: false, json: async () => ({}) };
    }),
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

  test('renders the install nudge with Install toolkit button and Show manual commands toggle when the plugin is not installed', async () => {
    mockDeployStatus({ pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: '0.7.4', stale: false });
    await mountAndFlush(root);

    const banner = container.querySelector('.plugin-install-banner');
    expect(banner).not.toBeNull();
    // The Install toolkit button should be present
    const installBtn = banner?.querySelector('.btn-install');
    expect(installBtn).not.toBeNull();
    expect(installBtn?.textContent).toBe('Install toolkit');
    // Manual commands should be hidden by default
    expect(banner?.textContent).toContain('Show manual commands');
    expect(banner?.textContent).not.toContain('/plugin marketplace add kookr-ai/kookr');
  });

  test('Show manual commands toggle reveals both slash commands', async () => {
    mockDeployStatus({ pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: '0.7.4', stale: false });
    await mountAndFlush(root);

    const banner = container.querySelector('.plugin-install-banner');
    const toggleBtn = banner?.querySelector('.linkish') as HTMLButtonElement | null;
    expect(toggleBtn).not.toBeNull();

    await act(async () => {
      toggleBtn?.click();
    });

    const text = banner?.textContent ?? '';
    expect(text).toContain('/plugin marketplace add kookr-ai/kookr');
    expect(text).toContain('/plugin install kookr-toolkit@kookr');
    expect(text).toContain('Hide manual commands');
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

  test('stays silent when not installed but the available version is unknown', async () => {
    // installedVersion null + availableVersion null: we can't prove an install
    // is possible, so the banner must not nudge.
    mockDeployStatus({ pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: null, stale: false });
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

  test('Install button opens confirmation dialog with safety callout', async () => {
    mockDeployStatus({ pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: '0.7.4', stale: false });
    await mountAndFlush(root);

    const installBtn = container.querySelector('.btn-install') as HTMLButtonElement | null;
    expect(installBtn).not.toBeNull();
    await act(async () => {
      installBtn?.click();
    });

    // Dialog should be visible
    const dialog = container.querySelector('.dialog');
    expect(dialog).not.toBeNull();
    const dialogText = dialog?.textContent ?? '';
    expect(dialogText).toContain('Install kookr-toolkit plugin?');
    expect(dialogText).toContain('kookr-ai/kookr');
    expect(dialogText).toContain('kookr-toolkit@kookr');
    expect(dialogText).toContain('Safe by default');
    // Actions
    const confirmBtn = dialog?.querySelector('.btn-primary');
    expect(confirmBtn?.textContent).toContain('Back up & install');
  });

  test('confirming install POSTs to /api/deploy/plugin-install and on success hides the banner', async () => {
    const installedPlugin: PluginPayload = {
      pluginId: 'kookr-toolkit@kookr',
      installedVersion: '0.7.4',
      availableVersion: '0.7.4',
      stale: false,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/deploy/status')) {
        return {
          ok: true,
          json: async () => ({
            plugin: { pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: '0.7.4', stale: false },
          }),
        };
      }
      if (String(url).includes('/api/deploy/plugin-install')) {
        return {
          ok: true,
          json: async () => ({
            status: 'installed',
            plugin: installedPlugin,
            commands: {
              slash: ['/plugin marketplace add kookr-ai/kookr', '/plugin install kookr-toolkit@kookr'],
              cli: ['claude plugin marketplace add kookr-ai/kookr', 'claude plugin install kookr-toolkit@kookr'],
            },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mountAndFlush(root);

    // Open dialog and confirm
    const installBtn = container.querySelector('.btn-install') as HTMLButtonElement | null;
    await act(async () => { installBtn?.click(); });

    const confirmBtn = container.querySelector('.dialog .btn-primary') as HTMLButtonElement | null;
    expect(confirmBtn).not.toBeNull();
    await act(async () => {
      confirmBtn?.click();
    });
    // Let async state updates settle
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Plugin is now installed so banner hides
    expect(container.querySelector('.plugin-install-banner')).toBeNull();
    // install endpoint was called
    const installCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('plugin-install'));
    expect(installCalls).toHaveLength(1);
  });

  test('on install error shows error message and manual commands inside dialog', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/deploy/status')) {
        return {
          ok: true,
          json: async () => ({
            plugin: { pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: '0.7.4', stale: false },
          }),
        };
      }
      if (String(url).includes('/api/deploy/plugin-install')) {
        return {
          ok: false,
          json: async () => ({
            error: 'marketplace add failed: network error',
            commands: {
              slash: ['/plugin marketplace add kookr-ai/kookr', '/plugin install kookr-toolkit@kookr'],
              cli: ['claude plugin marketplace add kookr-ai/kookr', 'claude plugin install kookr-toolkit@kookr'],
            },
            plugin: { pluginId: 'kookr-toolkit@kookr', installedVersion: null, availableVersion: '0.7.4', stale: false },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mountAndFlush(root);

    const installBtn = container.querySelector('.btn-install') as HTMLButtonElement | null;
    await act(async () => { installBtn?.click(); });

    const confirmBtn = container.querySelector('.dialog .btn-primary') as HTMLButtonElement | null;
    await act(async () => { confirmBtn?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // Banner is still shown (install failed)
    expect(container.querySelector('.plugin-install-banner')).not.toBeNull();
    // Dialog remains open with error
    const dialog = container.querySelector('.dialog');
    expect(dialog).not.toBeNull();
    const dialogText = dialog?.textContent ?? '';
    expect(dialogText).toContain('marketplace add failed: network error');
    // Fallback manual commands are shown
    expect(dialogText).toContain('/plugin marketplace add kookr-ai/kookr');
  });
});

function sendTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

function focusablesInDialog(el: HTMLElement): HTMLElement[] {
  const dialog = el.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) return [];
  const selector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');
  return Array.from(dialog.querySelectorAll<HTMLElement>(selector));
}

async function openInstallDialog(root: Root, container: HTMLElement): Promise<void> {
  mockDeployStatus({
    pluginId: 'kookr-toolkit@kookr',
    installedVersion: null,
    availableVersion: '0.7.4',
    stale: false,
  });
  await mountAndFlush(root);
  const installBtn = container.querySelector('.btn-install') as HTMLButtonElement | null;
  expect(installBtn).not.toBeNull();
  await act(async () => {
    installBtn?.click();
  });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
}

describe('PluginInstallBanner dialog focus management', () => {
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

  test('initial focus lands on Cancel', async () => {
    await openInstallDialog(root, container);

    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('.dialog button'))
      .find((b) => b.textContent?.trim() === 'Cancel');
    expect(cancel).not.toBeUndefined();
    expect(document.activeElement).toBe(cancel);
  });

  test('Tab from last focusable cycles to first; Shift+Tab from first cycles to last', async () => {
    await openInstallDialog(root, container);

    const focusables = focusablesInDialog(container);
    // Close (header) + Cancel + Back up & install
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(first);
    expect(forwardWrap.defaultPrevented).toBe(true);

    first.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(last);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('pulls focus back inside when Tab starts outside the dialog', async () => {
    await openInstallDialog(root, container);

    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const escapedFocus = sendTab();
    const first = focusablesInDialog(container)[0];
    expect(document.activeElement).toBe(first);
    expect(escapedFocus.defaultPrevented).toBe(true);
  });

  test('restores focus to the Install opener when closed', async () => {
    mockDeployStatus({
      pluginId: 'kookr-toolkit@kookr',
      installedVersion: null,
      availableVersion: '0.7.4',
      stale: false,
    });
    await mountAndFlush(root);

    const installBtn = container.querySelector('.btn-install') as HTMLButtonElement | null;
    expect(installBtn).not.toBeNull();
    installBtn!.focus();
    await act(async () => {
      installBtn!.click();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(installBtn);

    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('.dialog button'))
      .find((b) => b.textContent?.trim() === 'Cancel');
    await act(async () => {
      cancel?.click();
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(installBtn);
  });

  test('Escape closes the dialog', async () => {
    await openInstallDialog(root, container);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('while installing, Tab still pulls focus back into the dialog container', async () => {
    // Hang the install request so the dialog stays open with all actions disabled.
    let resolveInstall: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/deploy/status')) {
        return {
          ok: true,
          json: async () => ({
            plugin: {
              pluginId: 'kookr-toolkit@kookr',
              installedVersion: null,
              availableVersion: '0.7.4',
              stale: false,
            },
          }),
        };
      }
      if (String(url).includes('/api/deploy/plugin-install')) {
        return new Promise((resolve) => {
          resolveInstall = resolve;
        });
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mountAndFlush(root);

    const installBtn = container.querySelector('.btn-install') as HTMLButtonElement | null;
    await act(async () => {
      installBtn?.click();
    });

    const confirmBtn = container.querySelector('.dialog .btn-primary') as HTMLButtonElement | null;
    expect(confirmBtn).not.toBeNull();
    await act(async () => {
      confirmBtn?.click();
    });
    // Let React re-render with installing=true (buttons disabled).
    await act(async () => {
      await Promise.resolve();
    });

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('tabindex')).toBe('-1');
    // All action buttons are disabled while installing.
    const enabled = focusablesInDialog(container);
    expect(enabled).toHaveLength(0);

    // Simulate browser moving focus to body when the active button is disabled.
    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const escapedFocus = sendTab();
    expect(escapedFocus.defaultPrevented).toBe(true);
    expect(dialog?.contains(document.activeElement)).toBe(true);

    // Unblock the hanging install so the test can tear down cleanly.
    await act(async () => {
      resolveInstall?.({
        ok: false,
        json: async () => ({ error: 'aborted for test' }),
      });
      await Promise.resolve();
    });
  });
});
