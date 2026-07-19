// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AUTO_DISMISS_INFO_MS, Toasts } from './Toasts.js';
import { DestructiveUndoToasts } from './DestructiveUndoToasts.js';
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

  test('keeps polite and assertive live regions mounted when empty', () => {
    act(() => {
      root.render(React.createElement(Toasts));
    });

    const polite = container.querySelector('[data-testid="toast-live-polite"]');
    const assertive = container.querySelector('[data-testid="toast-live-assertive"]');

    expect(polite).toBeInstanceOf(HTMLDivElement);
    expect(assertive).toBeInstanceOf(HTMLDivElement);
    expect(polite?.getAttribute('role')).toBe('status');
    expect(polite?.getAttribute('aria-live')).toBe('polite');
    expect(polite?.getAttribute('aria-atomic')).toBe('true');
    expect(assertive?.getAttribute('role')).toBe('alert');
    expect(assertive?.getAttribute('aria-live')).toBe('assertive');
    expect(assertive?.getAttribute('aria-atomic')).toBe('true');
    expect(polite?.classList.contains('sr-only')).toBe(true);
    expect(assertive?.classList.contains('sr-only')).toBe(true);
    expect(polite?.textContent?.trim()).toBe('');
    expect(assertive?.textContent?.trim()).toBe('');
    expect(container.querySelector('.toasts')).toBeNull();
  });

  test('injects toast text into already-mounted live regions by severity', () => {
    act(() => {
      root.render(React.createElement(Toasts));
    });

    const polite = container.querySelector('[data-testid="toast-live-polite"]');
    const assertive = container.querySelector('[data-testid="toast-live-assertive"]');
    expect(polite).toBeTruthy();
    expect(assertive).toBeTruthy();

    act(() => {
      useKookrStore.getState().handleAlert('workspace', 'Sweep complete', 'info');
      useKookrStore.getState().handleAlert(
        '',
        'Error starting "demo": spawn failed',
        'error',
        'Run `pnpm run doctor` from the Kookr checkout.',
      );
    });

    act(() => {
      root.render(React.createElement(Toasts));
    });

    expect(polite?.textContent).toContain('Sweep complete');
    expect(polite?.textContent).not.toContain('Error starting "demo"');
    expect(assertive?.textContent).toContain('Error starting "demo"');
    expect(assertive?.textContent).toContain('pnpm run doctor');
    expect(assertive?.textContent).not.toContain('Sweep complete');
    // Same mounted nodes (not remounted with content already present).
    expect(container.querySelector('[data-testid="toast-live-polite"]')).toBe(polite);
    expect(container.querySelector('[data-testid="toast-live-assertive"]')).toBe(assertive);

    // Announcements route solely through the persistent regions (no double-read).
    const visibleToasts = container.querySelectorAll('.toast');
    expect(visibleToasts).toHaveLength(2);
    for (const toast of visibleToasts) {
      expect(toast.getAttribute('role')).toBeNull();
      expect(toast.getAttribute('aria-live')).toBeNull();
    }
  });

  test('dismiss button has an accessible name identifying the toast', () => {
    useKookrStore.getState().handleAlert('', 'Connection lost', 'error');

    act(() => {
      root.render(React.createElement(Toasts));
    });

    const dismiss = container.querySelector('.toast-dismiss');
    expect(dismiss).toBeInstanceOf(HTMLButtonElement);
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss: Connection lost');
  });
});

describe('DestructiveUndoToasts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  test('keeps a polite live region mounted when empty', () => {
    act(() => {
      root.render(
        React.createElement(DestructiveUndoToasts, {
          actions: [],
          onUndo: () => {},
        }),
      );
    });

    const polite = container.querySelector('[data-testid="destructive-undo-live-polite"]');
    expect(polite).toBeInstanceOf(HTMLDivElement);
    expect(polite?.getAttribute('role')).toBe('status');
    expect(polite?.getAttribute('aria-live')).toBe('polite');
    expect(polite?.getAttribute('aria-atomic')).toBe('true');
    expect(polite?.classList.contains('sr-only')).toBe(true);
    expect(polite?.textContent?.trim()).toBe('');
    expect(container.querySelector('.destructive-undo-toasts')).toBeNull();
  });

  test('injects undo summary into the already-mounted polite region', () => {
    act(() => {
      root.render(
        React.createElement(DestructiveUndoToasts, {
          actions: [],
          onUndo: () => {},
        }),
      );
    });

    const polite = container.querySelector('[data-testid="destructive-undo-live-polite"]');
    expect(polite).toBeTruthy();

    act(() => {
      root.render(
        React.createElement(DestructiveUndoToasts, {
          actions: [{ id: 'a1', summary: 'Deleting task "demo"', expiresAt: Date.now() + 5000 }],
          onUndo: () => {},
        }),
      );
    });

    expect(polite?.textContent).toContain('Deleting task "demo"');
    expect(container.querySelector('[data-testid="destructive-undo-live-polite"]')).toBe(polite);
    const visible = container.querySelector('.toast-undo');
    expect(visible?.getAttribute('role')).toBeNull();
    expect(visible?.getAttribute('aria-live')).toBeNull();
  });
});
