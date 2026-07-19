// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AUTO_DISMISS_INFO_MS, Toasts } from './Toasts.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

describe('Toasts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  test('renders alert details under the summary', () => {
    useKookrStore.getState().handleAlert(
      '',
      'Error starting "demo": spawn failed',
      'error',
      'Run `pnpm run doctor` from the Kookr checkout.',
    );

    act(() => {
      root.render(React.createElement(Toasts));
    });

    expect(container.querySelector('.toast-message')?.textContent).toContain('Error starting "demo"');
    expect(container.querySelector('.toast-details')?.textContent).toContain('pnpm run doctor');
  });

  test('pauses auto-dismiss on hover and resumes with the remaining time', () => {
    useKookrStore.getState().handleAlert('agent-1', 'Agent needs attention', 'info');

    act(() => {
      root.render(React.createElement(Toasts));
    });

    const toast = container.querySelector<HTMLElement>('.toast');
    expect(toast).not.toBeNull();

    act(() => vi.advanceTimersByTime(3_000));
    act(() => {
      toast?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(AUTO_DISMISS_INFO_MS));
    expect(container.querySelector('.toast')).not.toBeNull();

    act(() => {
      toast?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    act(() => vi.advanceTimersByTime(AUTO_DISMISS_INFO_MS - 3_001));
    expect(container.querySelector('.toast')).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector('.toast')).toBeNull();
  });

  test('keeps auto-dismiss paused while keyboard focus remains after hover ends', () => {
    useKookrStore.getState().handleAlert('agent-1', 'Agent needs attention', 'info');

    act(() => {
      root.render(React.createElement(Toasts));
    });

    const dismissButton = container.querySelector<HTMLButtonElement>('.toast-dismiss');
    const toast = container.querySelector<HTMLElement>('.toast');
    expect(dismissButton).not.toBeNull();
    expect(toast).not.toBeNull();

    act(() => dismissButton?.focus());
    act(() => {
      toast?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      toast?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    act(() => vi.advanceTimersByTime(AUTO_DISMISS_INFO_MS));
    expect(container.querySelector('.toast')).not.toBeNull();

    act(() => dismissButton?.blur());
    act(() => vi.advanceTimersByTime(AUTO_DISMISS_INFO_MS));
    expect(container.querySelector('.toast')).toBeNull();
  });
});
