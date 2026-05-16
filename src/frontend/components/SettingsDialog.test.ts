// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsDialog } from './SettingsDialog.js';
import type { AgentSelection } from '../../shared/protocol.js';

interface MockSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  autoWatchOssSources: boolean;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
  defaultAgentType: AgentSelection;
}

const DEFAULT_SETTINGS: MockSettings = {
  githubPollingEnabled: true,
  githubPollingIntervalSec: 60,
  autoWatchOssSources: true,
  watchdogStaleThresholdSec: 30,
  repeatedErrorThreshold: 3,
  maxActiveTasks: 10,
  defaultAgentType: 'claude-code',
};

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderDialog(container: HTMLElement, onClose = vi.fn()): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(SettingsDialog, { onClose }));
  });
  return root;
}

describe('SettingsDialog tabs', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => DEFAULT_SETTINGS,
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = renderDialog(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('defaults to the General tab and hides the hook inventory', async () => {
    await flush();

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['General', 'Sharing', 'Hooks']);

    const generalTab = tabs[0];
    const sharingTab = tabs[1];
    const hooksTab = tabs[2];
    expect(generalTab?.getAttribute('aria-selected')).toBe('true');
    expect(sharingTab?.getAttribute('aria-selected')).toBe('false');
    expect(hooksTab?.getAttribute('aria-selected')).toBe('false');

    expect(container.textContent).toContain('Enable polling');
    expect(container.textContent).not.toContain('SessionStart');
  });

  test('clicking the Hooks tab isolates the hook inventory from general settings', async () => {
    await flush();

    const hooksTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Hooks');
    expect(hooksTab).toBeDefined();

    await act(async () => {
      hooksTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(hooksTab?.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('SessionStart');
    expect(container.textContent).toContain('Want to add your own hooks?');
    expect(container.textContent).not.toContain('Enable polling');
  });

  test('arrow keys move between tabs and update the active panel', async () => {
    await flush();

    const generalTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'General');
    expect(generalTab).toBeDefined();

    generalTab!.focus();
    await act(async () => {
      generalTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flush();

    const sharingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Sharing');
    expect(sharingTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(sharingTab);

    await act(async () => {
      sharingTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flush();

    const hooksTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Hooks');
    expect(hooksTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(hooksTab);
    expect(container.textContent).toContain('SessionStart');

    await act(async () => {
      hooksTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    await flush();

    expect(sharingTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(sharingTab);

    await act(async () => {
      sharingTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    await flush();

    expect(generalTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(generalTab);
    expect(container.textContent).toContain('Enable polling');
    expect(container.textContent).not.toContain('SessionStart');
  });

  test('persists the default agent setting from Task Management', async () => {
    await flush();

    expect(container.textContent).toContain('Default agent');
    const select = container.querySelector<HTMLSelectElement>('.settings-agent-select select');
    expect(select).not.toBeNull();
    expect(select!.value).toBe('claude-code');

    await act(async () => {
      select!.value = 'codex-cli';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const fetchMock = vi.mocked(fetch);
    const putCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/settings' && init && init.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall![1]!.body))).toMatchObject({
      defaultAgentType: 'codex-cli',
    });
    expect(localStorage.getItem('kookr:defaultAgentType')).toBeNull();
  });

  test('offers and persists the round-robin default agent', async () => {
    await flush();

    const select = container.querySelector<HTMLSelectElement>('.settings-agent-select select');
    expect(select).not.toBeNull();
    const optionValues = Array.from(select!.options).map((o) => o.value);
    expect(optionValues).toContain('round-robin');

    await act(async () => {
      select!.value = 'round-robin';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const fetchMock = vi.mocked(fetch);
    const putCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/settings' && init && init.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall![1]!.body))).toMatchObject({
      defaultAgentType: 'round-robin',
    });
  });

  test('connects relay credentials from the Sharing tab with the share CSRF token', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/settings') {
        return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
      }
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-relay' }) } as Response;
      }
      if (url === '/api/relay-connection' && !init) {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: false,
              source: 'none',
              connectionState: 'localOnly',
              relayConnected: false,
            },
          }),
        } as Response;
      }
      if (url === '/api/relay-connection/connect' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: true,
              source: 'stored',
              relayUrl: 'http://relay.test',
              nodeId: 'kookr-node-test',
              connectionState: 'connected',
              relayConnected: true,
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    await flush();

    const sharingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Sharing');
    await act(async () => {
      sharingTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('.settings-field input'));
    await act(async () => {
      changeInput(inputs[0]!, 'http://relay.test');
      changeInput(inputs[1]!, 'kookr-node-test');
      changeInput(inputs[2]!, 'node-token-secret');
    });
    await flush();

    const connect = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Connect');
    expect(connect?.disabled).toBe(false);
    await act(async () => {
      connect!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const connectCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/relay-connection/connect' && init?.method === 'POST'
    );
    expect(connectCall).toBeDefined();
    expect(connectCall![1]!.headers).toMatchObject({ 'x-kookr-csrf': 'csrf-relay' });
    expect(JSON.parse(String(connectCall![1]!.body))).toEqual({
      relayUrl: 'http://relay.test',
      nodeId: 'kookr-node-test',
      relayToken: 'node-token-secret',
    });
  });

  test('pairs a custom relay with an admin token without sending a node token', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/settings') {
        return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
      }
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-relay' }) } as Response;
      }
      if (url === '/api/relay-connection' && !init) {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: false,
              source: 'none',
              connectionState: 'localOnly',
              relayConnected: false,
            },
          }),
        } as Response;
      }
      if (url === '/api/relay-connection/pair' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: true,
              source: 'stored',
              relayUrl: 'http://relay.test',
              nodeId: 'kookr-node-paired',
              displayName: 'Desk',
              connectionState: 'connected',
              relayConnected: true,
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    await flush();

    const sharingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Sharing');
    await act(async () => {
      sharingTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('.settings-field input'));
    await act(async () => {
      changeInput(inputs[0]!, 'http://relay.test');
      changeInput(inputs[3]!, 'admin-token-secret');
      changeInput(inputs[4]!, 'Desk');
    });
    await flush();

    const pair = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Pair');
    expect(pair?.disabled).toBe(false);
    await act(async () => {
      pair!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const pairCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/relay-connection/pair' && init?.method === 'POST'
    );
    expect(pairCall).toBeDefined();
    expect(pairCall![1]!.headers).toMatchObject({ 'x-kookr-csrf': 'csrf-relay' });
    expect(JSON.parse(String(pairCall![1]!.body))).toEqual({
      relayUrl: 'http://relay.test',
      relayAdminToken: 'admin-token-secret',
      displayName: 'Desk',
    });
  });

  test('pairs the hosted relay when the operational gate is ready', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/settings') {
        return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
      }
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-relay' }) } as Response;
      }
      if (url === '/api/relay-connection' && !init) {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: false,
              source: 'none',
              connectionState: 'localOnly',
              relayConnected: false,
              hostedRelay: {
                configured: true,
                relayUrl: 'https://share.kookr.dev',
                defaultEnabled: true,
                operationalGatesMet: true,
                mode: 'available',
                message: 'Hosted relay is ready.',
                checkedAt: '2026-05-16T00:00:00.000Z',
                gates: {
                  deploymentOwner: true,
                  environment: true,
                  tlsDomain: true,
                  accountDeviceAuth: true,
                  nodePairingAuth: true,
                  dataRetention: true,
                  rateLimitAbuse: true,
                  emergencyMaintenance: true,
                  metricsAlerts: true,
                },
              },
            },
          }),
        } as Response;
      }
      if (url === '/api/relay-connection/hosted/pair' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: true,
              source: 'hosted',
              relayUrl: 'https://share.kookr.dev',
              nodeId: 'kookr-node-hosted',
              connectionState: 'connected',
              relayConnected: true,
              hostedRelay: {
                configured: true,
                relayUrl: 'https://share.kookr.dev',
                defaultEnabled: true,
                operationalGatesMet: true,
                mode: 'available',
                message: 'Hosted relay is ready.',
                checkedAt: '2026-05-16T00:00:00.000Z',
                gates: {
                  deploymentOwner: true,
                  environment: true,
                  tlsDomain: true,
                  accountDeviceAuth: true,
                  nodePairingAuth: true,
                  dataRetention: true,
                  rateLimitAbuse: true,
                  emergencyMaintenance: true,
                  metricsAlerts: true,
                },
              },
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    await flush();

    const sharingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Sharing');
    await act(async () => {
      sharingTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('Hosted relay · Ready');
    const accountInput = Array.from(container.querySelectorAll<HTMLInputElement>('.settings-field input'))
      .find((input) => input.placeholder === 'Hosted relay account token');
    expect(accountInput).toBeDefined();
    await act(async () => {
      changeInput(accountInput!, 'account-token-secret');
    });
    await flush();

    const pairHosted = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Pair hosted relay');
    expect(pairHosted?.disabled).toBe(false);
    await act(async () => {
      pairHosted!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const pairCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/relay-connection/hosted/pair' && init?.method === 'POST'
    );
    expect(pairCall).toBeDefined();
    expect(pairCall![1]!.headers).toMatchObject({ 'x-kookr-csrf': 'csrf-relay' });
    expect(JSON.parse(String(pairCall![1]!.body))).toEqual({
      accountToken: 'account-token-secret',
    });
  });

  test('shows hosted relay maintenance without hiding local settings', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/settings') {
        return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
      }
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-relay' }) } as Response;
      }
      if (url === '/api/relay-connection' && !init) {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: false,
              source: 'none',
              connectionState: 'localOnly',
              relayConnected: false,
              hostedRelay: {
                configured: true,
                relayUrl: 'https://share.kookr.dev',
                defaultEnabled: true,
                operationalGatesMet: true,
                mode: 'maintenance',
                message: 'Hosted relay is in maintenance mode.',
                checkedAt: '2026-05-16T00:00:00.000Z',
                gates: {
                  deploymentOwner: true,
                  environment: true,
                  tlsDomain: true,
                  accountDeviceAuth: true,
                  nodePairingAuth: true,
                  dataRetention: true,
                  rateLimitAbuse: true,
                  emergencyMaintenance: true,
                  metricsAlerts: true,
                },
              },
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    await flush();

    const sharingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Sharing');
    await act(async () => {
      sharingTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('Hosted relay · Maintenance');
    expect(container.textContent).toContain('Local Kookr remains available');
    expect(container.textContent).toContain('Relay URL');
  });

  test('rotates a saved relay node token with a fresh admin token', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/settings') {
        return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
      }
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-relay' }) } as Response;
      }
      if (url === '/api/relay-connection' && !init) {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: true,
              source: 'stored',
              relayUrl: 'http://relay.test',
              nodeId: 'kookr-node-paired',
              connectionState: 'connected',
              relayConnected: true,
            },
          }),
        } as Response;
      }
      if (url === '/api/relay-connection/rotate' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            status: {
              configured: true,
              source: 'stored',
              relayUrl: 'http://relay.test',
              nodeId: 'kookr-node-paired',
              connectionState: 'connected',
              relayConnected: true,
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    await flush();

    const sharingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Sharing');
    await act(async () => {
      sharingTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('.settings-field input'));
    await act(async () => {
      changeInput(inputs[3]!, 'admin-token-secret');
    });
    await flush();

    const rotate = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Rotate token');
    expect(rotate?.disabled).toBe(false);
    await act(async () => {
      rotate!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const rotateCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/relay-connection/rotate' && init?.method === 'POST'
    );
    expect(rotateCall).toBeDefined();
    expect(rotateCall![1]!.headers).toMatchObject({ 'x-kookr-csrf': 'csrf-relay' });
    expect(JSON.parse(String(rotateCall![1]!.body))).toEqual({
      relayAdminToken: 'admin-token-secret',
    });
  });
});
