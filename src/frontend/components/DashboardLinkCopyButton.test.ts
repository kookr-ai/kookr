// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DashboardLinkCopyButton } from './DashboardLinkCopyButton.js';

const TASK_ID = 'a1d9db01-c638-43f9-8853-dfdba3cc0b2b';

describe('DashboardLinkCopyButton', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  test('copies http(s)://<host>/?task=<id> for the selected task', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const path = window.location.pathname.replace(/\/+$/, '');
    const expected = `${window.location.origin}${path}/?task=${TASK_ID}`;

    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(DashboardLinkCopyButton, { taskId: TASK_ID }));
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe(`Copy dashboard link for task ${TASK_ID}`);
    expect(button.textContent).toContain('Link');

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(expected);
    expect(button.textContent).toContain('Copied');
  });

  test('includes a non-root dashboard path in the copied URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    window.history.replaceState(null, '', '/kookr/');

    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(DashboardLinkCopyButton, { taskId: TASK_ID }));
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/kookr/?task=${TASK_ID}`);
  });

  test('renders nothing without a task id', () => {
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(DashboardLinkCopyButton, { taskId: undefined }));
    });
    expect(container.querySelector('button')).toBeNull();
  });
});
