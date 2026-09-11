// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuickLaunch } from './QuickLaunch.js';
import { GETTING_STARTED_GUIDE_URL } from './CliInstallGuidanceBanner.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AvailableAgentType, ClientMessage } from '../../shared/protocol.js';

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

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

function renderQuickLaunch(
  container: HTMLElement,
  send: (msg: ClientMessage) => boolean = () => true,
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(QuickLaunch, { send, onClose: () => {} }));
  });
  return root;
}

describe('QuickLaunch no-CLI-detected install banner (#3142)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/tmp/work',
      sttUrl: '',
      defaultAgentType: 'claude-code',
      selectedAgentId: null,
      agents: [],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('shows the install-guidance banner and keeps the picker + Launch when no CLI is advertised', async () => {
    useKookrStore.setState({ availableAgentTypes: [] });

    const root = renderQuickLaunch(container);
    await flush();

    const banner = container.querySelector('[data-testid="cli-install-guidance-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('No coding-agent CLI detected');
    expect(banner?.textContent).toContain('Claude Code');
    expect(banner?.textContent).toContain('Codex');
    expect(banner?.textContent).toContain('Grok Build');
    const link = banner?.querySelector('a');
    expect(link?.getAttribute('href')).toBe(GETTING_STARTED_GUIDE_URL);
    // Banner is wired into the input's aria-describedby so a screen reader
    // announces it when the field is focused (it is present at mount, so the
    // aria-live region alone would not announce it).
    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(
      'cli-install-guidance-banner',
    );

    // Non-blocking: the picker stays present and the input stays interactive.
    expect(container.querySelector('.agent-type-select select')).not.toBeNull();
    await act(async () => { setInputValue(input, 'still typeable'); });
    expect(input.value).toBe('still typeable');

    act(() => root.unmount());
  });

  test('reacts to availableAgentTypes arriving after mount (WS snapshot path)', async () => {
    // Production mounts with the store default [] and only populates on snapshot.
    useKookrStore.setState({ availableAgentTypes: [] });
    const root = renderQuickLaunch(container);
    await flush();
    expect(container.querySelector('[data-testid="cli-install-guidance-banner"]')).not.toBeNull();

    await act(async () => {
      useKookrStore.setState({
        availableAgentTypes: [{ type: 'claude-code', label: 'Claude Code' }],
      });
    });
    await flush();

    expect(container.querySelector('[data-testid="cli-install-guidance-banner"]')).toBeNull();
    act(() => root.unmount());
  });

  test('launch still dispatches with no advertised CLI (undetected-but-present provider)', async () => {
    useKookrStore.setState({ availableAgentTypes: [] });
    const sent: ClientMessage[] = [];
    const root = renderQuickLaunch(container, (msg) => { sent.push(msg); return true; });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'launch anyway');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launch' });
    act(() => root.unmount());
  });

  test('hides the banner when at least one CLI is advertised', async () => {
    const availableAgentTypes: AvailableAgentType[] = [
      { type: 'claude-code', label: 'Claude Code' },
    ];
    useKookrStore.setState({ availableAgentTypes });

    const root = renderQuickLaunch(container);
    await flush();

    expect(container.querySelector('[data-testid="cli-install-guidance-banner"]')).toBeNull();
    act(() => root.unmount());
  });
});
