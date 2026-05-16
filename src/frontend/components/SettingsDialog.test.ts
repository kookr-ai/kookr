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
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['General', 'Hooks']);

    const generalTab = tabs[0];
    const hooksTab = tabs[1];
    expect(generalTab?.getAttribute('aria-selected')).toBe('true');
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

    const hooksTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Hooks');
    expect(hooksTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(hooksTab);
    expect(container.textContent).toContain('SessionStart');

    await act(async () => {
      hooksTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
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
});
