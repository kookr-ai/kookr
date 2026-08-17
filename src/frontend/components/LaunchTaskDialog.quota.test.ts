// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage, QuotaStatus } from '../../shared/protocol.js';

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

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function getPromptEl(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not rendered');
  return el as HTMLTextAreaElement;
}

function getAgentSelectEl(container: HTMLElement): HTMLSelectElement {
  const el = container.querySelector('.agent-type-select select');
  if (!el) throw new Error('agent select not rendered');
  return el as HTMLSelectElement;
}

function getLaunchButton(container: HTMLElement): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((button) =>
    /Launch/.test(button.textContent ?? ''),
  );
  if (!el) throw new Error('Launch button not rendered');
  return el as HTMLButtonElement;
}

function exhaustedQuota(): QuotaStatus {
  return {
    fiveHour: { utilization: 92, resetsAt: '2099-01-01T00:00:00.000Z' },
    sevenDay: { utilization: 10, resetsAt: '2099-01-08T00:00:00.000Z' },
    updatedAt: Date.now(),
  };
}

function renderDialog(
  container: HTMLElement,
  defaultAgentType: 'claude-code' | 'codex-cli' | 'grok-build' | 'round-robin' = 'claude-code',
): { root: Root; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (msg: ClientMessage) => { sent.push(msg); return true; },
        onClose: () => {},
        defaultAgentType: defaultAgentType === 'round-robin' ? undefined : defaultAgentType,
      }),
    );
  });
  return { root, sent };
}

describe('LaunchTaskDialog Claude quota warning', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/tmp/work',
      sttUrl: '',
      availableAgentTypes: [
        { type: 'claude-code', label: 'Claude Code' },
        { type: 'codex-cli', label: 'Codex CLI' },
        { type: 'grok-build', label: 'Grok Build' },
      ],
      quotaHeadroomThreshold: 90,
      quotaStatus: exhaustedQuota(),
      roundRobinIndex: 0,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('exhausted 5-hour window shows a banner and still allows Launch', async () => {
    const { root, sent } = renderDialog(container, 'claude-code');
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'Fix the auth bug'); });
    await flush();

    const banner = container.querySelector('[data-testid="launch-quota-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('92%');
    expect(banner?.textContent).toContain('5-hour');
    expect(banner?.textContent).toContain('configured fallback');
    expect(getLaunchButton(container).disabled).toBe(false);

    await act(async () => { getLaunchButton(container).click(); });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launch', agentType: 'claude-code' });
    act(() => root.unmount());
  });

  test('banner is hidden when quota data is missing', async () => {
    useKookrStore.setState({ quotaStatus: null });
    const { root } = renderDialog(container, 'claude-code');
    await flush();
    expect(container.querySelector('[data-testid="launch-quota-banner"]')).toBeNull();
    act(() => root.unmount());
  });

  test('banner is hidden when the evaluator would admit', async () => {
    useKookrStore.setState({
      quotaStatus: {
        fiveHour: { utilization: 40, resetsAt: '2099-01-01T00:00:00.000Z' },
        sevenDay: { utilization: 10, resetsAt: '2099-01-08T00:00:00.000Z' },
        updatedAt: Date.now(),
      },
    });
    const { root } = renderDialog(container, 'claude-code');
    await flush();
    expect(container.querySelector('[data-testid="launch-quota-banner"]')).toBeNull();
    act(() => root.unmount());
  });

  test('banner is hidden when the chosen agent cannot be Claude Code', async () => {
    const { root } = renderDialog(container, 'codex-cli');
    await flush();
    expect(getAgentSelectEl(container).value).toBe('codex-cli');
    expect(container.querySelector('[data-testid="launch-quota-banner"]')).toBeNull();
    act(() => root.unmount());
  });
});
