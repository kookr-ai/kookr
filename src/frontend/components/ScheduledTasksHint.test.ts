// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ScheduledTasksHint } from './ScheduledTasksHint.js';
import { commandPaletteHintKeys } from '../../shared/contracts/shortcut-bindings.js';
import { STORAGE_KEY, reset } from '../store/scheduled-tasks-hint-status.js';

describe('ScheduledTasksHint', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  function button(text: string): HTMLButtonElement {
    const el = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => (b.textContent ?? '').includes(text) || b.getAttribute('aria-label') === text);
    if (!el) throw new Error(`button "${text}" not found`);
    return el;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  test('"Got it" hides without persisting (hint can reappear later)', () => {
    const onHide = vi.fn();
    root = createRoot(container);
    act(() => { root!.render(React.createElement(ScheduledTasksHint, { onHide })); });

    act(() => { button('Got it').click(); });

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test('the × close button hides without persisting', () => {
    const onHide = vi.fn();
    root = createRoot(container);
    act(() => { root!.render(React.createElement(ScheduledTasksHint, { onHide })); });

    act(() => { button('Dismiss hint').click(); });

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test('"Don\'t show again" persists the dismissal and hides', () => {
    const onHide = vi.fn();
    root = createRoot(container);
    act(() => { root!.render(React.createElement(ScheduledTasksHint, { onHide })); });

    act(() => { button('Don’t show again').click(); });

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  test('renders the platform-correct command-palette chord (Ctrl+K off macOS, ⌘K on macOS)', () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    root = createRoot(container);
    act(() => { root!.render(React.createElement(ScheduledTasksHint, { onHide: vi.fn() })); });

    const keys = Array.from(container.querySelectorAll('kbd')).map((el) => el.textContent);
    expect(keys).toEqual([...commandPaletteHintKeys('default')]);
    expect(keys).toContain('Ctrl');
    expect(keys).toContain('K');
    expect(keys).not.toContain('⌘K');

    act(() => root!.render(React.createElement(React.Fragment, null)));
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    act(() => { root!.render(React.createElement(ScheduledTasksHint, { onHide: vi.fn() })); });

    const macKeys = Array.from(container.querySelectorAll('kbd')).map((el) => el.textContent);
    expect(macKeys).toEqual([...commandPaletteHintKeys('mac')]);
    expect(macKeys).toEqual(['⌘K']);

    Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
  });

  test('Escape hides the hint', () => {
    const onHide = vi.fn();
    root = createRoot(container);
    act(() => { root!.render(React.createElement(ScheduledTasksHint, { onHide })); });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
