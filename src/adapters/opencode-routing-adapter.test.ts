import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { OpenCodeRoutingAdapter, isContainerHandle } from './opencode-routing-adapter.js';

function setup() {
  const store = new TaskStore();
  const tui = { launch: vi.fn(async () => 'kookr-tui1'), stop: vi.fn(async () => undefined), sendInput: vi.fn(async () => undefined), sendKeystroke: vi.fn(async () => undefined),
    captureDisplay: vi.fn(async () => 'pane'), onEvent: vi.fn(), onRefreshNeeded: vi.fn(), injectHookEvent: vi.fn(() => ({ parseStatus: 'ok' })),
    getEffectiveHookSettings: vi.fn(() => ({ agentType: 'opencode' })), getActiveHookSettings: vi.fn(() => undefined) };
  const container = { launch: vi.fn(async () => 'kookr-oc-abcd1234-tok123456789'), stop: vi.fn(async () => undefined), sendInput: vi.fn(async () => undefined), sendKeystroke: vi.fn(async () => undefined) };
  const router = new OpenCodeRoutingAdapter(tui as never, container as never, store);
  return { store, tui, container, router };
}

describe('OpenCodeRoutingAdapter', () => {
  test('a new task launches as a container and the mode is persisted only after the launch succeeds', async () => {
    const { store, container, tui, router } = setup();
    const t = store.createTask({ prompt: 'p', cwd: '/w' });
    container.launch.mockRejectedValueOnce(new Error('cap'));
    await expect(router.launch(t.id, 'p', '/w')).rejects.toThrow('cap');
    expect(store.getTask(t.id)!.metadata?.opencodeLaunchMode).toBeUndefined();
    await router.launch(t.id, 'p', '/w');
    expect(store.getTask(t.id)!.metadata?.opencodeLaunchMode).toBe('container');
    expect(tui.launch).not.toHaveBeenCalled();
  });

  test('a task persisted as tui stays tui (no silent switch when the flag turns on later)', async () => {
    const { store, container, tui, router } = setup();
    const t = store.createTask({ prompt: 'p', cwd: '/w', metadata: { opencodeLaunchMode: 'tui' } });
    await router.launch(t.id, 'p', '/w');
    expect(tui.launch).toHaveBeenCalledOnce();
    expect(container.launch).not.toHaveBeenCalled();
  });

  test('a pre-flag host task (has sessions, no recorded mode) stays on the TUI and is recorded as tui', async () => {
    const { store, container, tui, router } = setup();
    const t = store.createTask({ prompt: 'p', cwd: '/w' });
    store.addSession(t.id, { tmuxSession: 'kookr-old1', agentType: 'opencode', cwd: '/w', createdAt: new Date() });
    await router.launch(t.id, 'p', '/w', { sessionId: 'ses_1' });
    expect(tui.launch).toHaveBeenCalledOnce();
    expect(container.launch).not.toHaveBeenCalled();
    expect(store.getTask(t.id)!.metadata?.opencodeLaunchMode).toBe('tui');
  });

  test('a relaunch of a container task goes to the container adapter', async () => {
    const { store, container, router } = setup();
    const t = store.createTask({ prompt: 'p', cwd: '/w', metadata: { opencodeLaunchMode: 'container' } });
    await router.launch(t.id, 'p', '/w', { sessionId: 'ses_1' });
    expect(container.launch).toHaveBeenCalledOnce();
  });

  test('stop/sendInput/sendKeystroke route by handle alone (works after a restart with no map)', async () => {
    const { tui, container, router } = setup();
    await router.stop('kookr-oc-abcd1234-tok123456789');
    await router.sendInput('kookr-oc-abcd1234-tok123456789', 'x');
    await router.sendKeystroke('kookr-oc-abcd1234-tok123456789', 'Enter');
    expect([container.stop, container.sendInput, container.sendKeystroke].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    await router.stop('kookr-1234abcd');
    await router.sendInput('kookr-1234abcd', 'x');
    expect(tui.stop).toHaveBeenCalledOnce();
    expect(tui.sendInput).toHaveBeenCalledOnce();
    expect(isContainerHandle('kookr-1234abcd')).toBe(false);
  });

  test('events and display stay with the TUI adapter; container sessions expose no host hook settings', () => {
    const { tui, router } = setup();
    router.injectHookEvent('kookr-oc-abcd1234-tok123456789', '{}');
    expect(tui.injectHookEvent).toHaveBeenCalledOnce();
    expect(router.getEffectiveHookSettings('kookr-oc-abcd1234-tok123456789')).toBeUndefined();
    expect(router.getEffectiveHookSettings('kookr-1234abcd')).toBeDefined();
  });
});
