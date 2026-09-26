// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QuickLaunch } from './QuickLaunch.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { getCompactTasks } from '../api/index.js';

vi.mock('../api/index.js', () => ({ getCompactTasks: vi.fn(async () => []) }));
vi.mock('../hooks/useLaunchTaskCwds.js', () => ({ useLaunchTaskCwds: () => new Map() }));
vi.mock('../hooks/useGrokAuthStatus.js', () => ({ useGrokAuthStatus: () => null }));
vi.mock('../hooks/useRecentPrompts.js', () => ({ useRecentPrompts: () => [] }));

describe('Quick Launch clipboard directory', () => {
  let container: HTMLDivElement;
  let root: Root;
  const send = vi.fn(() => true);
  const onClose = vi.fn();
  const readText = vi.fn<() => Promise<string>>();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(getCompactTasks).mockResolvedValue([]);
    readText.mockResolvedValue('/tmp/pasted');
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
    const fresh = createKookrStore().getState();
    useKookrStore.setState(Object.fromEntries(Object.entries(fresh).filter(([, value]) => typeof value !== 'function')));
    useKookrStore.setState({ serverCwd: '/tmp/original', sttUrl: '', selectedAgentId: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  async function render() {
    await act(async () => root.render(React.createElement(QuickLaunch, { send, onClose })));
  }

  function button() {
    const el = container.querySelector<HTMLButtonElement>('button[aria-label="Use clipboard path"]');
    expect(el).not.toBeNull();
    return el!;
  }

  const cwd = () => container.querySelector('.quick-launch-cwd')?.textContent;

  test('opening exposes the control without reading the clipboard', async () => {
    await render();
    expect(button().closest('.quick-launch-bar')).not.toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });

  test.each([
    ['/home/me/proj', '/home/me/proj'],
    ['  ~/proj  ', '~/proj'],
    ['\n /tmp/project with spaces\r\n$ pwd', '/tmp/project with spaces'],
  ])('fills %j without submitting; Enter subsequently launches in that directory', async (clipboard, expected) => {
    readText.mockResolvedValue(clipboard);
    await render();
    const input = container.querySelector<HTMLInputElement>('.quick-launch-input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Review this project');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button().click());
    expect(cwd()).toBe(expected);
    expect(input.value).toBe('Review this project');
    expect(send).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'launch', cwd: expected, prompt: 'Review this project' }));
  });

  test.each(['prose', 'relative/path', '', '   '])('ignores non-path clipboard %j', async (clipboard) => {
    readText.mockResolvedValue(clipboard);
    await render();
    await act(async () => button().click());
    expect(cwd()).toBe('/tmp/original');
    expect(send).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test.each(['denied', 'unavailable'])('%s clipboard leaves the directory unchanged', async (mode) => {
    if (mode === 'denied') readText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    else Reflect.deleteProperty(navigator, 'clipboard');
    await render();
    await act(async () => button().click());
    expect(cwd()).toBe('/tmp/original');
    expect(send).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a delayed selected-task lookup cannot replace an explicitly pasted path', async () => {
    let resolveTasks!: (tasks: unknown) => void;
    vi.mocked(getCompactTasks).mockReturnValue(new Promise(resolve => { resolveTasks = resolve; }));
    useKookrStore.setState({ selectedAgentId: 'selected-session' });
    await render();
    await act(async () => button().click());
    await act(async () => resolveTasks([{ cwd: '/tmp/selected', sessions: [{ tmuxSession: 'selected-session' }] }]));
    expect(cwd()).toBe('/tmp/pasted');
  });

  test('Safari-style blur before the click does not close during a delayed read', async () => {
    let resolveRead!: (text: string) => void;
    readText.mockReturnValue(new Promise(resolve => { resolveRead = resolve; }));
    await render();
    const input = container.querySelector<HTMLInputElement>('.quick-launch-input')!;
    act(() => {
      input.blur();
      button().click();
    });
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 5)); });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolveRead('~/delayed'));
    expect(cwd()).toBe('~/delayed');
    expect(onClose).not.toHaveBeenCalled();
  });
});
