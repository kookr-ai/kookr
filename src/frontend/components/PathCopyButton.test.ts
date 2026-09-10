// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PathCopyButton } from './PathCopyButton.js';

const CWD = '/home/jean/git/kookr-worktrees/feat-issue-3138';

function renderButton(container: HTMLElement, cwd: string | undefined, onParentClick = vi.fn()): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        'div',
        { onClick: onParentClick },
        React.createElement(PathCopyButton, { cwd }),
      ),
    );
  });
  return root;
}

describe('PathCopyButton', () => {
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

  test('copies the working directory to the clipboard on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    root = renderButton(container, CWD);

    const button = container.querySelector('button') as HTMLButtonElement;
    // The path is not rendered as text; it lives in the aria-label / tooltip.
    expect(button.textContent).not.toContain(CWD);
    expect(button.getAttribute('aria-label')).toBe(`Copy working directory ${CWD}`);
    // Pre-click tooltip advertises the copy action and carries the full path.
    expect(button.getAttribute('title')).toBe(`Copy working directory: ${CWD}`);
    expect(button.className).not.toContain('copied');
    expect(button.querySelector('svg')).toBeTruthy();

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(CWD);
    // The transient "copied" confirmation must actually fire: the button flips
    // to the copied class and check-state title/tooltip after a successful copy.
    expect(button.className).toContain('copied');
    expect(button.getAttribute('title')).toBe('Copied working directory');
  });

  test('does not select the parent row when copying from a list row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onParentClick = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    root = renderButton(container, CWD, onParentClick);

    const button = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(CWD);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  test('falls back to document copy when clipboard access is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    // Capture the exact string handed to the copy fallback: the hidden textarea
    // must carry the full cwd at execCommand time, so a regression that copied
    // the wrong (stale/empty) value would fail here rather than pass silently.
    let copiedValue: string | undefined;
    const execCommand = vi.fn(() => {
      copiedValue = document.querySelector('textarea')?.value;
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
    });
    root = renderButton(container, CWD);

    const button = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe(CWD);
    expect(button.className).toContain('copied');
    // The fallback textarea is transient and must be cleaned up.
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('does not show a false confirmation when the copy fails', async () => {
    // copyText rejects when the async clipboard write throws; handleCopy must
    // swallow it and leave the button in its uncopied state — no false "Copied".
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    root = renderButton(container, CWD);

    const button = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(CWD);
    expect(button.className).not.toContain('copied');
    expect(button.getAttribute('title')).toBe(`Copy working directory: ${CWD}`);
  });

  test('reverts the transient confirmation after the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      root = renderButton(container, CWD);

      const button = container.querySelector('button') as HTMLButtonElement;
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(button.className).toContain('copied');

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(button.className).not.toContain('copied');
      expect(button.getAttribute('title')).toBe(`Copy working directory: ${CWD}`);
    } finally {
      vi.useRealTimers();
    }
  });

  test('renders nothing when the working directory is absent', () => {
    root = renderButton(container, undefined);
    expect(container.querySelector('button')).toBeNull();
  });

  test('renders nothing when the working directory is an empty string', () => {
    root = renderButton(container, '');
    expect(container.querySelector('button')).toBeNull();
  });
});
