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
});
