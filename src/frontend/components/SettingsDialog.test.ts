// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsDialog } from './SettingsDialog.js';

interface MockSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
}

const DEFAULT_SETTINGS: MockSettings = {
  githubPollingEnabled: true,
  githubPollingIntervalSec: 60,
  watchdogStaleThresholdSec: 30,
  repeatedErrorThreshold: 3,
  maxActiveTasks: 10,
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
});
