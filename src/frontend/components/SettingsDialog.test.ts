// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsDialog } from './SettingsDialog.js';
import { __resetSoundPreferenceForTests, getSoundPreferenceState } from '../audio/sound.js';
import type { AgentSelection } from '../../shared/protocol.js';

interface MockSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  autoWatchOssSources: boolean;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
  defaultAgentType: AgentSelection;
  cleanupWorktreeOnComplete: boolean;
  shortcutBindings: Record<string, Record<string, string>>;
}

function relayStatusWithAction(
  kind: 'fixEnv' | 'restartRelay' | 'repairRelayPairing' | 'restartKookr',
  reason: string,
  command: string,
) {
  return {
    configured: kind === 'repairRelayPairing',
    source: kind === 'repairRelayPairing' ? 'stored' : 'none',
    relayUrl: kind === 'repairRelayPairing' ? 'http://relay.test' : undefined,
    connectionState: kind === 'repairRelayPairing' ? 'authFailed' : 'localOnly',
    relayConnected: false,
    setupDiagnosis: {
      envState: kind === 'fixEnv' ? 'missing-env' : kind === 'restartRelay' ? 'restart-required' : 'ok',
      envMessage: reason,
      requiresRelayRestart: kind === 'restartRelay',
      envFilePath: '/tmp/kookr/.env',
      localRelayCommands: {
        start: 'pnpm relay:start',
        status: 'pnpm relay:status',
        logs: 'pnpm relay:logs',
        restart: 'pnpm relay:restart',
        stop: 'pnpm relay:stop',
        doctor: 'pnpm relay:doctor',
      },
      recommendedAction: { kind, command, reason },
    },
    hostedRelay: {
      configured: false,
      relayUrl: 'https://share.kookr.dev',
      defaultEnabled: false,
      operationalGatesMet: false,
      mode: 'notConfigured',
      message: 'Hosted relay is not enabled.',
      checkedAt: '2026-05-17T00:00:00.000Z',
      gates: {
        deploymentOwner: false,
        environment: false,
        tlsDomain: false,
        tenantIsolation: false,
        accountDeviceAuth: false,
        nodePairingAuth: false,
        dataRetention: false,
        rateLimitAbuse: false,
        emergencyMaintenance: false,
        metricsAlerts: false,
        privacyNotice: false,
        syntheticProbes: false,
        perTenantKillSwitch: false,
        logEvidenceRedaction: false,
        incidentEscalation: false,
      },
      terminalViewing: {
        enabled: false,
        blockReason: 'hosted-relay-production-gate',
        disabledTenants: 0,
      },
    },
  };
}

const DEFAULT_SETTINGS: MockSettings = {
  githubPollingEnabled: true,
  githubPollingIntervalSec: 60,
  autoWatchOssSources: true,
  watchdogStaleThresholdSec: 30,
  repeatedErrorThreshold: 3,
  maxActiveTasks: 10,
  defaultAgentType: 'claude-code',
  cleanupWorktreeOnComplete: true,
  shortcutBindings: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function sectionByTitle(container: HTMLElement, title: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('.settings-section')).find(
    (section) => section.querySelector('.settings-section-title')?.textContent?.trim() === title,
  );
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
    __resetSoundPreferenceForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = renderDialog(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    localStorage.clear();
    __resetSoundPreferenceForTests();
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

  test('blacklists an agent with a struck-through label and persists the list', async () => {
    await flush();

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init && init.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(String(init.body)),
        };
      }
      return { ok: true, status: 200, json: async () => DEFAULT_SETTINGS };
    });

    expect(container.textContent).toContain('Blacklisted agents');
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Blacklist Claude Code"]',
    );
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);

    await act(async () => {
      checkbox!.closest('label')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const fetchMock = vi.mocked(fetch);
    const putCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/settings' && init && init.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall![1]!.body))).toMatchObject({
      blacklistedAgentTypes: ['claude-code'],
      defaultAgentType: 'round-robin',
    });
    expect(container.querySelector('.settings-agent-blacklist-item.is-blacklisted')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>(
      'input[aria-label="Blacklist Claude Code"]',
    )?.checked).toBe(true);
  });

  test('persists the task completion cleanup default', async () => {
    await flush();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle worktree cleanup on task completion"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.classList.contains('active')).toBe(true);

    await act(async () => {
      toggle!.click();
    });
    await flush();

    const putCall = vi.mocked(fetch).mock.calls.find(([url, init]) =>
      url === '/api/settings' && init && init.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall![1]!.body))).toMatchObject({
      cleanupWorktreeOnComplete: false,
    });
  });

  test('updates client-local audio volume and chime preferences from controls', async () => {
    await flush();

    const volumeInput = container.querySelector<HTMLInputElement>('input[aria-label="Alert volume"]');
    const chimeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Chime sound"]');
    expect(volumeInput).not.toBeNull();
    expect(chimeSelect).not.toBeNull();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(volumeInput, '0.35');
      volumeInput!.dispatchEvent(new Event('input', { bubbles: true }));
      chimeSelect!.value = 'soft';
      chimeSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(getSoundPreferenceState()).toMatchObject({
      volume: 0.35,
      chimeSound: 'soft',
    });
    expect(localStorage.getItem('kookr-sound-volume')).toBe('0.35');
    expect(localStorage.getItem('kookr-chime-sound')).toBe('soft');
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

  test('serializes shortcut saves so older responses do not roll back newer edits', async () => {
    const onSettingsSaved = vi.fn();
    const firstPut = deferred<Response>();
    const secondPut = deferred<Response>();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((async (url, init) => {
      if (url === '/api/settings' && !init) {
        return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
      }
      if (url === '/api/settings' && init?.method === 'PUT') {
        const putIndex = fetchMock.mock.calls.filter(([callUrl, callInit]) =>
          callUrl === '/api/settings' && callInit?.method === 'PUT'
        ).length;
        return putIndex === 1 ? firstPut.promise : secondPut.promise;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch);

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(SettingsDialog, { onClose: vi.fn(), onSettingsSaved }));
    });
    await flush();

    const quickLaunch = container.querySelector<HTMLInputElement>('input[aria-label="Quick launch shortcut"]');
    const nextTask = container.querySelector<HTMLInputElement>('input[aria-label="Next task shortcut"]');
    expect(quickLaunch).not.toBeNull();
    expect(nextTask).not.toBeNull();

    await act(async () => {
      changeInput(quickLaunch!, 'Ctrl+Shift+L');
    });
    await flush();
    await act(async () => {
      quickLaunch!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();

    await act(async () => {
      changeInput(nextTask!, 'Ctrl+Shift+J');
    });
    await flush();
    await act(async () => {
      nextTask!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();

    expect(fetchMock.mock.calls.filter(([url, init]) => url === '/api/settings' && init?.method === 'PUT')).toHaveLength(1);
    const firstPutCall = fetchMock.mock.calls.find(([url, init]) => url === '/api/settings' && init?.method === 'PUT');
    expect(JSON.parse(String(firstPutCall![1]!.body)).shortcutBindings).toEqual({
      default: { quick_launch: 'Ctrl+Shift+L' },
    });

    await act(async () => {
      firstPut.resolve({
        ok: true,
        json: async () => ({
          ...DEFAULT_SETTINGS,
          shortcutBindings: { default: { quick_launch: 'Ctrl+Shift+L' } },
        }),
      } as Response);
      await firstPut.promise;
    });
    await flush();

    expect(onSettingsSaved).not.toHaveBeenCalled();
    expect(quickLaunch!.value).toBe('Ctrl+Shift+L');
    expect(nextTask!.value).toBe('Ctrl+Shift+J');
    const putCalls = fetchMock.mock.calls.filter(([url, init]) => url === '/api/settings' && init?.method === 'PUT');
    expect(putCalls).toHaveLength(2);
    expect(JSON.parse(String(putCalls[1]![1]!.body)).shortcutBindings).toEqual({
      default: {
        quick_launch: 'Ctrl+Shift+L',
        next_task: 'Ctrl+Shift+J',
      },
    });

    await act(async () => {
      secondPut.resolve({
        ok: true,
        json: async () => ({
          ...DEFAULT_SETTINGS,
          shortcutBindings: {
            default: {
              quick_launch: 'Ctrl+Shift+L',
              next_task: 'Ctrl+Shift+J',
            },
          },
        }),
      } as Response);
      await secondPut.promise;
    });
    await flush();

    expect(onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(onSettingsSaved).toHaveBeenLastCalledWith(expect.objectContaining({
      shortcutBindings: {
        default: {
          quick_launch: 'Ctrl+Shift+L',
          next_task: 'Ctrl+Shift+J',
        },
      },
    }));
  });

  test('debounced numeric saves use the latest settings including reply snippets', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/settings' && !init) {
        return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
      }
      if (url === '/api/settings' && init?.method === 'PUT') {
        return { ok: true, json: async () => JSON.parse(String(init.body)) } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    await flush();
    const staleTimeout = container.querySelector<HTMLInputElement>('input[aria-label="Stale agent timeout"]');
    expect(staleTimeout).not.toBeNull();

    await act(async () => {
      changeInput(staleTimeout!, '45');
    });

    const addSnippet = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Add snippet');
    expect(addSnippet).toBeDefined();
    await act(async () => {
      addSnippet!.click();
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    await flush();

    const putCalls = fetchMock.mock.calls.filter(([url, init]) => url === '/api/settings' && init?.method === 'PUT');
    expect(putCalls.length).toBeGreaterThanOrEqual(2);
    const lastBody = JSON.parse(String(putCalls.at(-1)![1]!.body));
    expect(lastBody.watchdogStaleThresholdSec).toBe(45);
    expect(lastBody.replySnippets).toEqual([{ label: 'New reply', text: 'continue' }]);
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

  test.each([
    ['fixEnv', 'Fix env', 'No .env file or process relay admin token was found.', 'Set KOOKR_RELAY_ADMIN_TOKEN in /tmp/kookr/.env'] as const,
    ['restartRelay', 'Restart relay', 'Relay env changed after the relay process started.', 'pnpm relay:restart'] as const,
    ['repairRelayPairing', 'Reconnect node', 'Relay rejected the configured node credential.', 'Open Settings > Sharing and pair this node again.'] as const,
    ['restartKookr', 'Restart Kookr', 'The relay admin token is present in .env but the running Kookr process has not loaded it.', 'pnpm prod:restart'] as const,
  ])('surfaces %s relay setup diagnosis in Settings', async (kind, label, reason, command) => {
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
            status: relayStatusWithAction(kind, reason, command),
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

    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain(reason);
    expect(container.textContent).toContain(command);
  });

  test('makes relay admin-token-only setup actionable through Pair instead of Connect', async () => {
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
    });
    await flush();

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const connect = buttons.find((button) => button.textContent?.trim() === 'Connect');
    const pair = buttons.find((button) => button.textContent?.trim() === 'Pair');
    expect(connect?.disabled).toBe(true);
    expect(pair?.disabled).toBe(false);
    expect(container.textContent).toContain('Use Pair with a relay admin token to create this node ID and token.');
    expect(container.textContent).toContain('Use Connect only when you already have both.');
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
                  tenantIsolation: true,
                  accountDeviceAuth: true,
                  nodePairingAuth: true,
                  dataRetention: true,
                  rateLimitAbuse: true,
                  emergencyMaintenance: true,
                  metricsAlerts: true,
                  privacyNotice: true,
                  syntheticProbes: true,
                  perTenantKillSwitch: true,
                  logEvidenceRedaction: true,
                  incidentEscalation: true,
                },
                terminalViewing: {
                  enabled: false,
                  blockReason: 'hosted-relay-maintenance',
                  disabledTenants: 0,
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
                  tenantIsolation: true,
                  accountDeviceAuth: true,
                  nodePairingAuth: true,
                  dataRetention: true,
                  rateLimitAbuse: true,
                  emergencyMaintenance: true,
                  metricsAlerts: true,
                  privacyNotice: true,
                  syntheticProbes: true,
                  perTenantKillSwitch: true,
                  logEvidenceRedaction: true,
                  incidentEscalation: true,
                },
                terminalViewing: { enabled: true, disabledTenants: 0 },
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
                  tenantIsolation: true,
                  accountDeviceAuth: true,
                  nodePairingAuth: true,
                  dataRetention: true,
                  rateLimitAbuse: true,
                  emergencyMaintenance: true,
                  metricsAlerts: true,
                  privacyNotice: true,
                  syntheticProbes: true,
                  perTenantKillSwitch: true,
                  logEvidenceRedaction: true,
                  incidentEscalation: true,
                },
                terminalViewing: { enabled: true, disabledTenants: 0 },
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

  test('announces failed recovery results as errors', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
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
      if (url === '/api/session-sharing/recovery/revokeAllShares' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            result: {
              action: 'revokeAllShares',
              auditId: 'audit-1',
              state: 'partial',
              message: 'Revoked 1 shares; 1 revocations failed.',
              affected: [],
              verification: 'Some relay revoke calls failed; retry after checking relay logs.',
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

    const revokeAll = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Revoke all shares');
    expect(revokeAll?.disabled).toBe(false);
    await act(async () => {
      revokeAll!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Revoked 1 shares; 1 revocations failed.');
    expect(container.textContent).not.toContain('Relay logs are at');
    confirmSpy.mockRestore();
  });

  test('search filters General settings to matching rows and hides other sections', async () => {
    await flush();

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
    expect(search).not.toBeNull();

    await act(async () => {
      changeInput(search!, 'Quiet hours');
    });
    await flush();

    const notifications = sectionByTitle(container, 'Notifications & Alerts');
    const taskManagement = sectionByTitle(container, 'Task Management');
    expect(notifications).toBeDefined();
    expect(taskManagement).toBeDefined();
    // The section owning the matched row stays visible; unrelated sections hide.
    expect(notifications!.style.display).not.toBe('none');
    expect(taskManagement!.style.display).toBe('none');

    // Within the matched section, the matching row stays while a sibling hides.
    const quietHoursRow = container
      .querySelector('.settings-quiet-hours')
      ?.closest<HTMLElement>('.settings-row');
    const soundRow = container
      .querySelector('[aria-label="Toggle sound alerts"]')
      ?.closest<HTMLElement>('.settings-row');
    expect(quietHoursRow).toBeDefined();
    expect(soundRow).toBeDefined();
    expect(quietHoursRow!.style.display).not.toBe('none');
    expect(soundRow!.style.display).toBe('none');
  });

  test('clearing the search query restores every section', async () => {
    await flush();

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
    await act(async () => {
      changeInput(search!, 'Quiet hours');
    });
    await flush();
    expect(sectionByTitle(container, 'Task Management')!.style.display).toBe('none');

    await act(async () => {
      changeInput(search!, '');
    });
    await flush();

    for (const section of Array.from(container.querySelectorAll<HTMLElement>('.settings-section'))) {
      expect(section.style.display).not.toBe('none');
    }
    for (const row of Array.from(container.querySelectorAll<HTMLElement>('.settings-row'))) {
      expect(row.style.display).not.toBe('none');
    }
  });

  test('search switches to the Hooks tab when the only match lives there', async () => {
    await flush();

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
    await act(async () => {
      changeInput(search!, 'SessionStart');
    });
    await flush();

    const hooksTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Hooks');
    expect(hooksTab?.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('SessionStart');

    // Guard against a "switched but shows nothing" regression: jsdom textContent
    // includes display:none nodes, so also assert the Hooks section is actually
    // visible and that a non-matching hook row was filtered out.
    const hooksSection = sectionByTitle(container, 'Hooks (read-only)');
    expect(hooksSection).toBeDefined();
    expect(hooksSection!.style.display).not.toBe('none');
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.hook-inventory-row'));
    const nonMatchingRow = rows.find((row) => !row.textContent?.includes('SessionStart'));
    expect(nonMatchingRow).toBeDefined();
    expect(nonMatchingRow!.style.display).toBe('none');
  });

  test('search switches to the Sharing tab when the only match lives there', async () => {
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
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    await flush();

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
    // "Node ID" is a Sharing field label that is NOT part of the section's
    // first title — it exercises the structure-agnostic filter (the Sharing
    // panel is one section, two titles, zero .settings-row elements).
    await act(async () => {
      changeInput(search!, 'Node ID');
    });
    await flush();

    const sharingTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Sharing');
    expect(sharingTab?.getAttribute('aria-selected')).toBe('true');
    // The Sharing section stays visible (not force-hidden into a false "no
    // results"), and the empty-state message is absent.
    const relaySection = sectionByTitle(container, 'Relay Connection');
    expect(relaySection).toBeDefined();
    expect(relaySection!.style.display).not.toBe('none');
    expect(container.textContent).not.toContain('No settings match');
  });

  test('search reports when nothing matches on any tab', async () => {
    await flush();

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
    await act(async () => {
      changeInput(search!, 'zzzznotasetting');
    });
    await flush();

    expect(container.textContent).toContain('No settings match');
    for (const section of Array.from(container.querySelectorAll<HTMLElement>('.settings-section'))) {
      expect(section.style.display).toBe('none');
    }
  });
});

describe('SettingsDialog desktop-notification permission row', () => {
  let container: HTMLDivElement;
  let root: Root;

  function stubNotification(
    permission: NotificationPermission,
    requestPermission?: ReturnType<typeof vi.fn>,
  ): void {
    const ctor = vi.fn() as unknown as {
      permission: NotificationPermission;
      requestPermission: () => Promise<NotificationPermission>;
    };
    ctor.permission = permission;
    ctor.requestPermission = requestPermission ?? vi.fn(async () => permission);
    vi.stubGlobal('Notification', ctor);
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => DEFAULT_SETTINGS,
    })));
    __resetSoundPreferenceForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    localStorage.clear();
    __resetSoundPreferenceForTests();
  });

  test('shows an On indicator and no enable button when permission is granted', async () => {
    stubNotification('granted');
    root = renderDialog(container);
    await flush();

    const status = container.querySelector('.settings-permission-status.granted');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('On');
    expect(container.querySelector('[aria-label="Enable desktop notifications"]')).toBeNull();
    expect(container.textContent).not.toContain('Re-enable them in your');
  });

  test('offers a working enable action when permission is default', async () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    stubNotification('default', requestPermission);
    root = renderDialog(container);
    await flush();

    const enableButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Enable desktop notifications"]',
    );
    expect(enableButton).not.toBeNull();
    expect(container.querySelector('.settings-permission-status')).toBeNull();

    await act(async () => {
      enableButton!.click();
    });
    await flush();

    expect(requestPermission).toHaveBeenCalledTimes(1);
    // After granting, the row flips to the On indicator and the button is gone.
    const status = container.querySelector('.settings-permission-status.granted');
    expect(status).not.toBeNull();
    expect(container.querySelector('[aria-label="Enable desktop notifications"]')).toBeNull();
  });

  test('flips to blocked guidance when the enable prompt is dismissed', async () => {
    const requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
    stubNotification('default', requestPermission);
    root = renderDialog(container);
    await flush();

    const enableButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Enable desktop notifications"]',
    );
    expect(enableButton).not.toBeNull();

    await act(async () => {
      enableButton!.click();
    });
    await flush();

    expect(requestPermission).toHaveBeenCalledTimes(1);
    // A dismissed/blocked prompt resolves to 'denied'; the row must surface the
    // re-enable guidance and drop the now-dead Enable button.
    const status = container.querySelector('.settings-permission-status.denied');
    expect(status).not.toBeNull();
    expect(container.querySelector('[aria-label="Enable desktop notifications"]')).toBeNull();
    expect(container.textContent).toContain('Re-enable them in your');
  });

  test('keeps reflecting reality when requestPermission rejects', async () => {
    // Legacy callback-style implementations can throw when awaited. The handler
    // must fall back to re-reading the current permission rather than crashing.
    const requestPermission = vi.fn(async () => {
      throw new Error('legacy callback API');
    });
    stubNotification('default', requestPermission as unknown as ReturnType<typeof vi.fn>);
    root = renderDialog(container);
    await flush();

    const enableButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Enable desktop notifications"]',
    );
    expect(enableButton).not.toBeNull();

    await act(async () => {
      enableButton!.click();
    });
    await flush();

    expect(requestPermission).toHaveBeenCalledTimes(1);
    // Permission stayed 'default', so the row keeps offering the enable action
    // instead of getting stuck or throwing.
    expect(container.querySelector('[aria-label="Enable desktop notifications"]')).not.toBeNull();
    expect(container.querySelector('.settings-permission-status')).toBeNull();
  });

  test('shows re-enable guidance and no dead button when permission is denied', async () => {
    stubNotification('denied');
    root = renderDialog(container);
    await flush();

    const status = container.querySelector('.settings-permission-status.denied');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('Blocked');
    expect(container.querySelector('[aria-label="Enable desktop notifications"]')).toBeNull();
    expect(container.textContent).toContain('Re-enable them in your');
  });

  test('renders no permission row when the Notification API is unavailable', async () => {
    vi.stubGlobal('Notification', undefined);
    root = renderDialog(container);
    await flush();

    expect(container.textContent).toContain('Notifications & Alerts');
    expect(container.querySelector('.settings-permission')).toBeNull();
    expect(container.querySelector('[aria-label="Enable desktop notifications"]')).toBeNull();
  });
});
