// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuickLaunch } from './QuickLaunch.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage } from '../../shared/protocol.js';

// QuickLaunch's module-level RecentPaths instance captures the browser storage
// object before individual tests replace global localStorage with a fake.
const recentPathStorage = localStorage;

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush() {
  // Two microtask turns: the cwd-resolve effect and any follow-up state set.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

/**
 * React attaches a property setter to HTMLInputElement.value; to trigger an
 * onChange reliably in jsdom we have to use the prototype's native setter so
 * React's internal input-tracker sees a value change.
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('QuickLaunch optimistic toast', () => {
  let container: HTMLDivElement;
  let root: Root;
  let localStore: Map<string, string>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStore = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => localStore.set(key, value),
      removeItem: (key: string) => localStore.delete(key),
      clear: () => localStore.clear(),
    });
    recentPathStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/tmp/work' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    recentPathStorage.clear();
    vi.unstubAllGlobals();
  });

  test('submitting a prompt sends first, then pushes a "Launching task" info toast on success', async () => {
    const sent: ClientMessage[] = [];
    let alertWhenSent: number | null = null;
    const send = (msg: ClientMessage): boolean => {
      alertWhenSent = useKookrStore.getState().alerts.length;
      sent.push(msg);
      return true;
    };
    await act(async () => {
      root.render(React.createElement(QuickLaunch, { send, onClose: () => {} }));
    });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => { setInputValue(input, 'Add pagination to the /users route'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // Send happens BEFORE the toast is pushed — reviewer flagged the prior
    // ordering because useWebSocket.send returns false when the socket is
    // closed; pushing the optimistic toast first would lie to the user.
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('launch');
    expect(alertWhenSent).toBe(0);

    const { alerts } = useKookrStore.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('info');
    expect(alerts[0].summary).toBe('Launching task: Add pagination to the /users route');
  });

  test('long prompts are truncated to 40 chars with ellipsis in the toast', async () => {
    const send = (_msg: ClientMessage): boolean => true;
    await act(async () => {
      root.render(React.createElement(QuickLaunch, { send, onClose: () => {} }));
    });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    const long = 'y'.repeat(60);
    await act(async () => { setInputValue(input, long); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    const { alerts } = useKookrStore.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toBe(`Launching task: ${'y'.repeat(40)}…`);
  });

  test('empty or whitespace-only prompts do not push a toast', async () => {
    const sent: ClientMessage[] = [];
    await act(async () => {
      root.render(React.createElement(QuickLaunch, {
        send: (m) => { sent.push(m); return true; },
        onClose: () => {},
      }));
    });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => { setInputValue(input, '   '); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toHaveLength(0);
    expect(useKookrStore.getState().alerts).toHaveLength(0);
  });

  test('R4b.4: a failed send keeps the full launch draft for a successful retry', async () => {
    useKookrStore.setState({ defaultAgentType: 'codex-cli' });
    const sent: ClientMessage[] = [];
    let connected = false;
    const send = (msg: ClientMessage): boolean => {
      sent.push(msg);
      return connected;
    };
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = React.useState(true);
      return open
        ? React.createElement(QuickLaunch, {
          send,
          onClose: () => {
            onClose();
            setOpen(false);
          },
        })
        : null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await flush();

    const agentSelect = container.querySelector('.agent-type-select select') as HTMLSelectElement;
    expect(agentSelect.value).toBe('codex-cli');
    await act(async () => { setSelectValue(agentSelect, 'claude-code'); });
    await flush();

    const effortSelect = container.querySelector('select[aria-label="Reasoning effort"]') as HTMLSelectElement;
    const modelSelect = container.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
    await act(async () => {
      setSelectValue(effortSelect, 'high');
      setSelectValue(modelSelect, 'claude-fable-5');
    });

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => { setInputValue(input, 'Fix the nav bug'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'launch',
      prompt: 'Fix the nav bug',
      cwd: '/tmp/work',
      agentType: 'claude-code',
      effort: 'high',
      model: 'claude-fable-5',
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('.quick-launch-bar')).not.toBeNull();
    expect(input.value).toBe('Fix the nav bug');
    expect(agentSelect.value).toBe('claude-code');
    expect(effortSelect.value).toBe('high');
    expect(modelSelect.value).toBe('claude-fable-5');
    expect(recentPathStorage.getItem('kookr:recentPaths')).toBeNull();

    // A reconnect replaces snapshot-backed store values. The launch draft is
    // user-owned after a failed send, so those refreshes must not overwrite it.
    const availableAgentTypes = useKookrStore.getState().availableAgentTypes;
    await act(async () => {
      useKookrStore.setState({
        agents: [],
        availableAgentTypes: [...availableAgentTypes],
        serverCwd: '/tmp/reconnected-work',
      });
    });
    await flush();
    expect((container.querySelector('.quick-launch-cwd') as HTMLElement).textContent).toBe('/tmp/work');
    expect(input.value).toBe('Fix the nav bug');
    expect(agentSelect.value).toBe('claude-code');
    expect(effortSelect.value).toBe('high');
    expect(modelSelect.value).toBe('claude-fable-5');

    let { alerts } = useKookrStore.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('error');
    expect(alerts[0].summary).toBe('Could not start task: not connected. Fix the nav bug');

    connected = true;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.quick-launch-bar')).toBeNull();
    expect(JSON.parse(recentPathStorage.getItem('kookr:recentPaths') ?? 'null')).toEqual(['/tmp/work']);
    alerts = useKookrStore.getState().alerts;
    expect(alerts).toHaveLength(2);
    expect(alerts[1].severity).toBe('info');
    expect(alerts[1].summary).toBe('Launching task: Fix the nav bug');
  });

  test('R4b.4: successful dispatch still closes when recent-path storage fails', async () => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });
    const sent: ClientMessage[] = [];
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(QuickLaunch, {
        send: (msg) => { sent.push(msg); return true; },
        onClose,
      }));
    });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => { setInputValue(input, 'Fix the nav bug'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useKookrStore.getState().alerts.at(-1)).toMatchObject({
      severity: 'info',
      summary: 'Launching task: Fix the nav bug',
    });
    storageWrite.mockRestore();
  });
});
