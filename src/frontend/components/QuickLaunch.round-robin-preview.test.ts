// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QuickLaunch } from './QuickLaunch.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage, GrokAuthStatusResponse } from '../../shared/protocol.js';
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

function mockGrokAuth(body: GrokAuthStatusResponse): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes(GROK_AUTH_STATUS_PATH)) {
      // Everything else (compact-task fetch, etc.) fails open.
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
}

function mockGrokAuthUnavailable(): void {
  // Every request 404s, including the grok-auth path — the preflight verdict
  // is unknown, so useGrokAuthStatus leaves grokAuth null (fail-open) and never
  // refreshes the cursor.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
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

function nextLabel(container: HTMLElement): string | undefined {
  return container.querySelector('.agent-type-select-next')?.textContent ?? undefined;
}

function renderQuickLaunch(container: HTMLElement): { root: Root } {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(QuickLaunch, {
        send: (_msg: ClientMessage) => true,
        onClose: () => {},
      }),
    );
  });
  return { root };
}

describe('QuickLaunch round-robin preview honors Grok auth', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/tmp/work',
      sttUrl: '',
      // Cursor 2 lands on grok-build in the full rotation, so dropping Grok is
      // observable: with all three usable the preview is "Grok Build"; with
      // Grok unusable the rotation is [claude, codex] and 2 % 2 → "Claude Code".
      // Individual tests override this to make the preflight's cursor refresh
      // load-bearing or to pin the fail-open case.
      roundRobinIndex: 2,
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

  test('skips Grok in the preview when the launch preflight would refuse it', async () => {
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

    // The launch skips an unusable grok-build, so the preview must not promise it.
    expect(nextLabel(container)).toBe('Next: Claude Code');

    act(() => root.unmount());
  });

  test('previews Grok when the preflight reports it usable, driven by the refreshed cursor', async () => {
    // Seed a stale cursor (0 → Claude Code) and let the preflight advertise 2.
    // If useGrokAuthStatus did not refresh the cursor the preview would read
    // "Claude Code"; asserting "Grok Build" proves the refresh is load-bearing.
    useKookrStore.setState({ roundRobinIndex: 0 });
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

    expect(nextLabel(container)).toBe('Next: Grok Build');

    act(() => root.unmount());
  });

  test('stays fail-open (previews Grok) when the preflight is unavailable', async () => {
    // Unknown auth must not fail-closed: with the preflight unreachable, grokAuth
    // is null and the wiring passes grokAuthUsable=undefined, so Grok stays in
    // the rotation (cursor 2 → Grok Build). A regression flipping the ternary
    // fallback to fail-closed would drop Grok and read "Claude Code".
    useKookrStore.setState({ roundRobinIndex: 2 });
    mockGrokAuthUnavailable();

    const { root } = renderQuickLaunch(container);
    await flush();
    await act(async () => { selectValue(getAgentSelectEl(container), 'round-robin'); });
    await flush();

    expect(nextLabel(container)).toBe('Next: Grok Build');

    act(() => root.unmount());
  });
});
