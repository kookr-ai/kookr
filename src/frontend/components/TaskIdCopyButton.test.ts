// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TaskIdCopyButton } from './TaskIdCopyButton.js';

const TASK_ID = 'a1d9db01-c638-43f9-8853-dfdba3cc0b2b';

function renderButton(container: HTMLElement, compact = false, onParentClick = vi.fn()): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        'div',
        { onClick: onParentClick },
        React.createElement(TaskIdCopyButton, { taskId: TASK_ID, compact }),
      ),
    );
  });
  return root;
}

describe('TaskIdCopyButton', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  test('copies the full task id while displaying the shortened id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    root = renderButton(container);

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('ID a1d9db01');

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(TASK_ID);
    expect(button.textContent).toContain('Copied');
  });

  test('does not select the parent row when copying from a list row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onParentClick = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    root = renderButton(container, true, onParentClick);

    const button = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(TASK_ID);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  test('icon-only mode copies without showing the id text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const root0 = createRoot(container);
    act(() => {
      root0.render(React.createElement(TaskIdCopyButton, { taskId: TASK_ID, iconOnly: true }));
    });
    root = root0;

    const button = container.querySelector('button') as HTMLButtonElement;
    // No id characters are shown; the id is available via aria-label instead.
    expect(button.textContent).not.toContain('a1d9db01');
    expect(button.getAttribute('aria-label')).toBe(`Copy task ID ${TASK_ID}`);
    expect(button.className).toContain('btn-icon');
    expect(button.querySelector('svg')).toBeTruthy();

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(TASK_ID);
  });

  test('falls back to document copy when clipboard access is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
    });
    root = renderButton(container);

    const button = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(button.textContent).toContain('Copied');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
