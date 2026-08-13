// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage, GrokAuthStatusResponse } from '../../shared/protocol.js';
import { GROK_AUTH_STATUS_PATH, GROK_LOGIN_COMMAND } from '../../shared/protocol.js';

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

function renderDialog(
  container: HTMLElement,
  defaultAgentType: 'claude-code' | 'codex-cli' | 'grok-build' | 'round-robin' = 'grok-build',
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

describe('LaunchTaskDialog Grok auth preflight banner', () => {
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
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('expired status shows a banner that contains grok login', async () => {
    mockGrokAuth({
      status: 'expired',
      loginCommand: GROK_LOGIN_COMMAND,
      message: `Grok authentication expired. Run \`${GROK_LOGIN_COMMAND}\` and retry.`,
      launchWouldRefuse: true,
      roundRobinIndex: 0,
    });

    const { root } = renderDialog(container, 'grok-build');
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'Fix the auth bug'); });
    await flush();

    const banner = container.querySelector('[data-testid="grok-auth-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('grok login');
    expect(getLaunchButton(container).disabled).toBe(true);
    act(() => root.unmount());
  });

  test('ok status shows no banner', async () => {
    mockGrokAuth({
      status: 'ok',
      loginCommand: GROK_LOGIN_COMMAND,
      message: null,
      launchWouldRefuse: false,
      roundRobinIndex: 0,
    });

    const { root } = renderDialog(container, 'grok-build');
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'Fix the auth bug'); });
    await flush();

    expect(container.querySelector('[data-testid="grok-auth-banner"]')).toBeNull();
    expect(getLaunchButton(container).disabled).toBe(false);
    act(() => root.unmount());
  });

  test('expired status does not banner or block Claude Code', async () => {
    mockGrokAuth({
      status: 'expired',
      loginCommand: GROK_LOGIN_COMMAND,
      message: `Run \`${GROK_LOGIN_COMMAND}\`.`,
      launchWouldRefuse: true,
      roundRobinIndex: 2,
    });

    const { root, sent } = renderDialog(container, 'claude-code');
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'Fix the auth bug'); });
    await flush();

    expect(container.querySelector('[data-testid="grok-auth-banner"]')).toBeNull();
    expect(getAgentSelectEl(container).value).toBe('claude-code');
    expect(getLaunchButton(container).disabled).toBe(false);
    await act(async () => { getLaunchButton(container).click(); });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('launch');
    act(() => root.unmount());
  });

  test('round-robin shows the banner when Grok would be next', async () => {
    mockGrokAuth({
      status: 'missing',
      loginCommand: GROK_LOGIN_COMMAND,
      message: `No credential file. Run \`${GROK_LOGIN_COMMAND}\`.`,
      launchWouldRefuse: true,
      roundRobinIndex: 2,
    });
    useKookrStore.setState({ defaultAgentType: 'round-robin' });

    const { root } = renderDialog(container, 'round-robin');
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'Fix the auth bug'); });
    await flush();

    expect(getAgentSelectEl(container).value).toBe('round-robin');
    const banner = container.querySelector('[data-testid="grok-auth-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('grok login');
    expect(getLaunchButton(container).disabled).toBe(false);
    act(() => root.unmount());
  });
});
