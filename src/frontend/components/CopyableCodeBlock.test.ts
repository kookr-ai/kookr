// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CopyableCodeBlock } from './CopyableCodeBlock.js';

// A payload with leading/trailing whitespace, blank lines, and markdown-looking
// characters — copying it verbatim proves there is no trimming or annotation
// drift between the rendered block and the clipboard.
const CODE = '  git commit -m "**wip**"\n\n  echo `done`  ';

function render(container: HTMLElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(CopyableCodeBlock, { code: CODE }));
  });
  return root;
}

describe('CopyableCodeBlock', () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  test('renders the block body exactly, inside pre > code', () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
    root = render(container);

    const code = container.querySelector('pre.md-pre > code.md-code-block');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe(CODE);
  });

  test('copies the exact code and transitions Copy → Copied → Copy', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    root = render(container);

    const button = container.querySelector('button.md-copy-btn') as HTMLButtonElement;
    expect(button.textContent).toBe('Copy');

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // The copied payload matches the rendered code exactly — no trim/annotate.
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Copied');
    expect(button.className).toContain('copied');

    // The transient state reverts after the timeout.
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(button.textContent).toBe('Copy');
    expect(button.className).not.toContain('copied');
  });

  test('does not bubble the click to an enclosing handler', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onParentClick = vi.fn();

    const localRoot = createRoot(container);
    act(() => {
      localRoot.render(
        React.createElement(
          'div',
          { onClick: onParentClick },
          React.createElement(CopyableCodeBlock, { code: CODE }),
        ),
      );
    });
    root = localRoot;

    const button = container.querySelector('button.md-copy-btn') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  test('stays on "Copy" without throwing when the clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    root = render(container);

    const button = container.querySelector('button.md-copy-btn') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(CODE);
    // The rejection is swallowed; the button never enters the "Copied" state.
    expect(button.textContent).toBe('Copy');
    expect(button.className).not.toContain('copied');
  });

  test('falls back to execCommand copy when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
    });
    root = render(container);

    const button = container.querySelector('button.md-copy-btn') as HTMLButtonElement;
    let copiedValue: string | undefined;
    // Capture the textarea's value at copy time, before it is removed.
    execCommand.mockImplementation(() => {
      copiedValue = (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value;
      return true;
    });

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe(CODE);
    expect(button.textContent).toBe('Copied');
    // The temporary textarea is cleaned up.
    expect(document.querySelector('textarea')).toBeNull();
  });
});
