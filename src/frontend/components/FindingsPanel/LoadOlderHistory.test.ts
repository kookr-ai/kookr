// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LoadOlderHistoryControl } from './LoadOlderHistory.js';

describe('LoadOlderHistoryControl (issue #2760)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<React.ComponentProps<typeof LoadOlderHistoryControl>> = {}) {
    const onLoad = props.onLoad ?? vi.fn();
    act(() => {
      root.render(React.createElement(LoadOlderHistoryControl, {
        canLoad: true,
        loading: false,
        error: null,
        empty: false,
        onLoad,
        ...props,
      }));
    });
    return onLoad;
  }

  test('renders the Load older history affordance', () => {
    render();
    const button = container.querySelector('[data-testid="load-older-history"]');
    expect(button?.textContent).toBe('Load older history');
  });

  test('shows a non-blocking loading state', () => {
    render({ canLoad: true, loading: true });
    expect(container.querySelector('[data-testid="completed-history-loading"]')?.textContent).toBe('Loading older history…');
    const button = container.querySelector('[data-testid="load-older-history"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Loading older history…');
  });

  test('shows empty history after a successful empty page', () => {
    render({ canLoad: false, empty: true });
    expect(container.querySelector('[data-testid="completed-history-empty"]')?.textContent).toBe('No older history');
    expect(container.querySelector('[data-testid="load-older-history"]')).toBeNull();
  });

  test('shows archive-error and a retry control', () => {
    const onLoad = render({ error: 'archive unreadable', canLoad: false });
    expect(container.querySelector('[data-testid="completed-history-error"]')?.textContent).toContain('archive unreadable');
    const retry = container.querySelector('[data-testid="load-older-history"]') as HTMLButtonElement;
    expect(retry.textContent).toBe('Retry older history');
    act(() => retry.click());
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  test('renders nothing when history is exhausted without an error', () => {
    render({ canLoad: false, loading: false, error: null, empty: false });
    expect(container.querySelector('[data-testid="completed-history-control"]')).toBeNull();
  });
});
