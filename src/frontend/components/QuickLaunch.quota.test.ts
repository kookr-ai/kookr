// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QuickLaunch } from './QuickLaunch.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage, GrokAuthStatusResponse, QuotaStatus } from '../../shared/protocol.js';
import { GROK_AUTH_STATUS_PATH } from '../../shared/protocol.js';

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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function getPromptEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input.quick-launch-input');
  if (!el) throw new Error('quick-launch input not rendered');
  return el as HTMLInputElement;
}

function getAgentSelectEl(container: HTMLElement): HTMLSelectElement {
  const el = container.querySelector('.agent-type-select select');
  if (!el) throw new Error('agent select not rendered');
  return el as HTMLSelectElement;
}

function selectValue(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function exhaustedQuota(): QuotaStatus {
  return {
    fiveHour: { utilization: 92, resetsAt: '2099-01-01T00:00:00.000Z' },
    sevenDay: { utilization: 10, resetsAt: '2099-01-08T00:00:00.000Z' },
    updatedAt: Date.now(),
  };
}

function mockGrokAuth(body: GrokAuthStatusResponse): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes(GROK_AUTH_STATUS_PATH)) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
}

function renderQuickLaunch(container: HTMLElement): { root: Root; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(QuickLaunch, {
      send: (msg: ClientMessage) => { sent.push(msg); return true; },
      onClose: () => {},
    }));
  });
  return { root, sent };
}

describe('QuickLaunch Claude quota warning (#3344)', () => {
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
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('exhausted 5-hour window shows the same banner as Launch and still launches on Enter', async () => {
    const { root, sent } = renderQuickLaunch(container);
    await flush();

    const banner = container.querySelector('[data-testid="launch-quota-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('92%');
    expect(banner?.textContent).toContain('5-hour');
    expect(banner?.textContent).toContain('configured fallback');

    const input = getPromptEl(container);
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain('launch-quota-banner');

    await act(async () => { setInputValue(input, 'Fix the auth bug'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launch', agentType: 'claude-code' });
    act(() => root.unmount());
  });

  test('banner is hidden when quota data is missing', async () => {
    useKookrStore.setState({ quotaStatus: null });
    const { root } = renderQuickLaunch(container);
    await flush();
    expect(container.querySelector('[data-testid="launch-quota-banner"]')).toBeNull();
    expect(getPromptEl(container).getAttribute('aria-describedby') ?? '').not.toContain('launch-quota-banner');
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
    const { root } = renderQuickLaunch(container);
    await flush();
    expect(container.querySelector('[data-testid="launch-quota-banner"]')).toBeNull();
    act(() => root.unmount());
  });

  test('banner is hidden when the chosen agent cannot be Claude Code', async () => {
    const { root } = renderQuickLaunch(container);
    await flush();
    await act(async () => { selectValue(getAgentSelectEl(container), 'codex-cli'); });
    await flush();
    expect(getAgentSelectEl(container).value).toBe('codex-cli');
    expect(container.querySelector('[data-testid="launch-quota-banner"]')).toBeNull();
    expect(getPromptEl(container).getAttribute('aria-describedby') ?? '').not.toContain('launch-quota-banner');
    act(() => root.unmount());
  });

  test('round-robin still warns when Grok is next but unusable, so the launch would land on Claude', async () => {
    // Cursor 2 is grok-build in the full rotation. The Launch dialog drops
    // unusable Grok before asking who is next, so this compact bar must too.
    useKookrStore.setState({ roundRobinIndex: 2 });
    mockGrokAuth({
      status: 'expired',
      loginCommand: 'grok login --device-code',
      message: 'Grok authentication expired. Run `grok login --device-code`.',
      launchWouldRefuse: true,
      roundRobinIndex: 2,
    });

    const { root } = renderQuickLaunch(container);
    await flush();
    await act(async () => { selectValue(getAgentSelectEl(container), 'round-robin'); });
    await flush();

    expect(getAgentSelectEl(container).value).toBe('round-robin');
    expect(container.querySelector('.agent-type-select-next')?.textContent).toBe('Next: Claude Code');
    const banner = container.querySelector('[data-testid="launch-quota-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('92%');
    expect(getPromptEl(container).getAttribute('aria-describedby')?.split(' ')).toContain('launch-quota-banner');
    act(() => root.unmount());
  });

  test('round-robin hides the banner when Grok is next and usable', async () => {
    useKookrStore.setState({ roundRobinIndex: 2 });
    mockGrokAuth({
      status: 'ok',
      loginCommand: 'grok login --device-code',
      message: null,
      launchWouldRefuse: false,
      roundRobinIndex: 2,
    });

    const { root } = renderQuickLaunch(container);
    await flush();
    await act(async () => { selectValue(getAgentSelectEl(container), 'round-robin'); });
    await flush();

    expect(getAgentSelectEl(container).value).toBe('round-robin');
    expect(container.querySelector('.agent-type-select-next')?.textContent).toBe('Next: Grok Build');
    expect(container.querySelector('[data-testid="launch-quota-banner"]')).toBeNull();
    expect(getPromptEl(container).getAttribute('aria-describedby') ?? '').not.toContain('launch-quota-banner');
    act(() => root.unmount());
  });
});
