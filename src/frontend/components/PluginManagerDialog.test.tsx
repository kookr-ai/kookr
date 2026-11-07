// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PluginManagerDialog } from './PluginManagerDialog.js';
import type { ManagedPlugin, PluginsReadModel } from '../../shared/contracts/plugins.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function plugin(overrides: Partial<ManagedPlugin> = {}): ManagedPlugin {
  return {
    id: 'kookr-toolkit@kookr',
    installedVersion: '0.16.81',
    availableVersion: '0.16.81',
    enablement: 'enabled',
    staleness: { state: 'current', source: 'git', observedAt: '2026-11-07T12:00:00.000Z' },
    loadSource: 'marketplace',
    alwaysOnTokens: 8994,
    uninstallGuard: true,
    marketplaceRegistered: true,
    ...overrides,
  };
}

describe('PluginManagerDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function text(): string {
    return container.textContent ?? '';
  }

  function buttonByText(label: string): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label);
    if (!btn) throw new Error(`button "${label}" not found`);
    return btn as HTMLButtonElement;
  }

  async function renderWith(body: PluginsReadModel, fetchMock = vi.fn(async () => jsonResponse(body))) {
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(React.createElement(PluginManagerDialog, { isOpen: true, onClose: vi.fn() }));
    });
    // Flush the load() promise + state update.
    await act(async () => {});
    return fetchMock;
  }

  test('lists every plugin with enablement, staleness, and token cost', async () => {
    await renderWith({
      plugins: [
        plugin(),
        plugin({
          id: 'stripe@anthropic-plugin-directory',
          installedVersion: '0.11.40',
          availableVersion: null,
          enablement: 'default',
          staleness: { state: 'unknown', reason: 'Catalog not refreshed', source: 'catalog', observedAt: '2026-11-07T12:00:00.000Z' },
          alwaysOnTokens: null,
          uninstallGuard: false,
        }),
      ],
    });
    const body = text();
    expect(body).toContain('kookr-toolkit');
    expect(body).toContain('stripe');
    expect(body).toContain('Enabled'); // toolkit tri-state
    expect(body).toContain('Default'); // stripe tri-state (absent ≠ disabled)
    expect(body).toContain('Up to date'); // toolkit staleness
    expect(body).toContain('Unknown'); // stripe staleness
    expect(body).toContain('8,994'); // token cost
  });

  test('disables Update for a current plugin and enables it only when behind', async () => {
    await renderWith({
      plugins: [
        plugin({ id: 'a@m', staleness: { state: 'current', source: 'git', observedAt: 'x' } }),
        plugin({ id: 'b@m', installedVersion: '1.0.0', availableVersion: '2.0.0', staleness: { state: 'behind', source: 'git', observedAt: 'x' } }),
      ],
    });
    const updateButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Update');
    expect(updateButtons).toHaveLength(2);
    // First row (current) disabled; second (behind) enabled.
    expect(updateButtons[0].disabled).toBe(true);
    expect(updateButtons[1].disabled).toBe(false);
  });

  test('updating a behind plugin posts to the update route and refreshes the row', async () => {
    const behind = plugin({ id: 'b@m', installedVersion: '1.0.0', availableVersion: '2.0.0', staleness: { state: 'behind', source: 'git', observedAt: 'x' } });
    const updated = plugin({ id: 'b@m', installedVersion: '2.0.0', availableVersion: '2.0.0', staleness: { state: 'current', source: 'git', observedAt: 'y' } });
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST') return jsonResponse({ status: 'updated', plugin: updated });
      return jsonResponse({ plugins: [behind] });
    });
    await renderWith({ plugins: [behind] }, fetchMock);
    expect(buttonByText('Update').disabled).toBe(false);

    await act(async () => buttonByText('Update').click());
    await act(async () => {});

    expect(calls).toContain('POST /api/plugins/b%40m/update');
    // Row now reads 2.0.0 / up to date → Update disabled.
    expect(text()).toContain('v2.0.0');
    expect(buttonByText('Update').disabled).toBe(true);
  });

  test('shows a retry affordance when the load fails', async () => {
    await renderWith({ plugins: [] }, vi.fn(async () => jsonResponse({ error: 'nope' }, 500)));
    expect(text()).toContain('Could not load plugins');
  });

  // --- P3: own-session assist + drift surface ---

  /** Route a fetch by path so each endpoint answers independently. */
  function routingFetch(handlers: {
    plugins: PluginsReadModel;
    drift?: unknown;
    autoUpdate?: unknown;
    onPost?: (url: string, init?: RequestInit) => Response;
    calls?: string[];
  }) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      handlers.calls?.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/api/plugins/auto-update') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(handlers.autoUpdate ?? { plugins: [], recentDecisions: [], applyEnabled: false });
      }
      if (url.includes('/api/plugins/config-drift')) {
        return jsonResponse(
          handlers.drift ?? { currentEpoch: 0, staleSessions: [], staleCount: 0, externalCoverageNote: 'n/a' },
        );
      }
      if (init?.method === 'POST' || init?.method === 'PUT') {
        return handlers.onPost?.(url, init) ?? jsonResponse({ status: 'applied', epoch: 1 });
      }
      return jsonResponse(handlers.plugins);
    });
  }

  test('enable/disable shows the blast-radius disclosure before applying, then posts', async () => {
    const calls: string[] = [];
    const fetchMock = routingFetch({
      plugins: { plugins: [plugin({ id: 'x@m', enablement: 'enabled', uninstallGuard: false })] },
      onPost: () => jsonResponse({ status: 'applied', pluginId: 'x@m', scope: 'user', enablement: 'disabled', previousValue: true, backupPath: null, epoch: 2 }),
      calls,
    });
    await renderWith({ plugins: [] }, fetchMock);

    await act(async () => buttonByText('Disable').click());
    // Disclosure shown; nothing posted yet.
    expect(text()).toContain('affects all of your Claude Code sessions');
    expect(text()).toContain('/reload-plugins');
    expect(calls.some((c) => c.startsWith('POST /api/plugins/own-session/enablement'))).toBe(false);

    await act(async () => buttonByText('Apply').click());
    await act(async () => {});
    expect(calls.some((c) => c.startsWith('POST /api/plugins/own-session/enablement'))).toBe(true);
    expect(text()).toContain('Disabled');
  });

  test('uninstall-guarded plugin adds an extra confirmation note (never one-click)', async () => {
    const fetchMock = routingFetch({
      plugins: { plugins: [plugin({ id: 'kookr-toolkit@kookr', enablement: 'enabled', uninstallGuard: true })] },
    });
    await renderWith({ plugins: [] }, fetchMock);
    await act(async () => buttonByText('Disable').click());
    expect(text()).toContain('Kookr depends on');
  });

  test('degrades marketplace-scoped action to "open in /plugin" when the marketplace is unregistered', async () => {
    const fetchMock = routingFetch({
      plugins: {
        plugins: [
          plugin({
            id: 'stripe@anthropic-plugin-directory',
            installedVersion: '1.0.0',
            availableVersion: '2.0.0',
            staleness: { state: 'behind', source: 'catalog', observedAt: 'x' },
            marketplaceRegistered: false,
            uninstallGuard: false,
          }),
        ],
      },
    });
    await renderWith({ plugins: [] }, fetchMock);
    expect(text()).toContain('Open in');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Update')).toBe(false);
  });

  test('surfaces reload drift with a restart action', async () => {
    const onRestart = vi.fn();
    const fetchMock = routingFetch({
      plugins: { plugins: [plugin({ id: 'x@m', uninstallGuard: false })] },
      drift: {
        currentEpoch: 3,
        staleSessions: [{ taskId: 't-1', startedEpoch: 1, startedAt: '2026-11-07T10:00:00.000Z', title: 'My session' }],
        staleCount: 1,
        externalCoverageNote: 'External TUIs are invisible to Kookr.',
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(React.createElement(PluginManagerDialog, { isOpen: true, onClose: vi.fn(), onRestartSession: onRestart }));
    });
    await act(async () => {});
    expect(text()).toContain('1 session started before your last change');
    expect(text()).toContain('External TUIs are invisible to Kookr.');
    await act(async () => buttonByText('Restart').click());
    expect(onRestart).toHaveBeenCalledWith('t-1');
  });

  test('installing a plugin for own sessions posts after the disclosure', async () => {
    const calls: string[] = [];
    const fetchMock = routingFetch({ plugins: { plugins: [] }, calls });
    await renderWith({ plugins: [] }, fetchMock);

    await act(async () => buttonByText('+ Add a plugin').click());
    const idInput = container.querySelector('input[aria-label="Plugin id"]') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(idInput, 'foo@bar');
      idInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => buttonByText('Install').click());
    // Disclosure first.
    expect(text()).toContain('affects all of your Claude Code sessions');
    await act(async () => buttonByText('Apply').click());
    await act(async () => {});
    expect(calls.some((c) => c.startsWith('POST /api/plugins/own-session/install'))).toBe(true);
  });

  // --- P4: fleet-aware auto-update ---

  function auView(overrides: Record<string, unknown> = {}) {
    return { pluginId: 'x@m', policy: 'off', lastDecision: null, banner: null, rollbackAvailable: false, ...overrides };
  }

  test('policy select reflects the current policy and changing it posts', async () => {
    const calls: string[] = [];
    const fetchMock = routingFetch({
      plugins: { plugins: [plugin({ id: 'x@m', uninstallGuard: false })] },
      autoUpdate: { plugins: [auView({ policy: 'notify' })], recentDecisions: [], applyEnabled: true },
      onPost: () => jsonResponse({ status: 'ok', plugin: auView({ policy: 'apply-when-idle' }) }),
      calls,
    });
    await renderWith({ plugins: [] }, fetchMock);
    const select = container.querySelector('select[aria-label="Auto-update policy for x"]') as HTMLSelectElement;
    expect(select.value).toBe('notify');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'apply-when-idle');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {});
    expect(calls.some((c) => c === 'PUT /api/plugins/x%40m/auto-update')).toBe(true);
    expect((container.querySelector('select[aria-label="Auto-update policy for x"]') as HTMLSelectElement).value).toBe('apply-when-idle');
  });

  test('a verify-failed banner renders and Dismiss calls the dismiss route', async () => {
    const calls: string[] = [];
    const fetchMock = routingFetch({
      plugins: { plugins: [plugin({ id: 'x@m', uninstallGuard: false })] },
      autoUpdate: {
        plugins: [
          auView({
            banner: { pluginId: 'x@m', kind: 'verify-failed', message: 'Verification failed after update', raisedAt: '2026-11-07T12:00:00.000Z' },
            lastDecision: { pluginId: 'x@m', evaluatedAt: '2026-11-07T12:00:00.000Z', policy: 'apply-when-idle', state: 'skipped', reason: 'busy', busyTaskIds: ['a', 'b'] },
          }),
        ],
        recentDecisions: [],
        applyEnabled: true,
      },
      onPost: () => jsonResponse({ status: 'ok', plugin: auView() }),
      calls,
    });
    await renderWith({ plugins: [] }, fetchMock);
    expect(text()).toContain('Verification failed after update');
    expect(text()).toContain('busy: 2 tasks');
    await act(async () => buttonByText('Dismiss').click());
    await act(async () => {});
    expect(calls.some((c) => c.startsWith('POST') && c.includes('dismiss'))).toBe(true);
    expect(text()).not.toContain('Verification failed after update');
  });

  test('Rollback stages the confirm panel and applies on confirm', async () => {
    const calls: string[] = [];
    const fetchMock = routingFetch({
      plugins: { plugins: [plugin({ id: 'x@m', uninstallGuard: false })] },
      autoUpdate: { plugins: [auView({ rollbackAvailable: true })], recentDecisions: [], applyEnabled: true },
      onPost: () => jsonResponse({ status: 'ok', plugin: auView({ rollbackAvailable: false }) }),
      calls,
    });
    await renderWith({ plugins: [] }, fetchMock);
    await act(async () => buttonByText('Rollback').click());
    expect(text()).toContain('needs a restart');
    expect(calls.some((c) => c.startsWith('POST') && c.includes('rollback'))).toBe(false);
    await act(async () => buttonByText('Apply').click());
    await act(async () => {});
    expect(calls.some((c) => c.startsWith('POST') && c.includes('rollback'))).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Rollback')).toBe(false);
  });

  test('shows the audit trail and a notify-only note when apply is disabled', async () => {
    const fetchMock = routingFetch({
      plugins: { plugins: [plugin({ id: 'x@m', uninstallGuard: false })] },
      autoUpdate: {
        plugins: [],
        recentDecisions: [{ pluginId: 'x@m', evaluatedAt: '2026-11-07T12:00:00.000Z', policy: 'notify', state: 'skipped', reason: 'busy' }],
        applyEnabled: false,
      },
    });
    await renderWith({ plugins: [] }, fetchMock);
    expect(text()).toContain('Recent auto-update activity');
    expect(text()).toContain('KOOKR_PLUGIN_AUTO_UPDATE');
    expect(text()).toContain('x@m · skipped · busy');
  });
});
