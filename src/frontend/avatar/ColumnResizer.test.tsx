// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ColumnResizer } from './ColumnResizer.js';

const CLASS = 'avatar-column-resizing';

describe('ColumnResizer, a drag in progress', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const onResize = vi.fn();
  const onCommit = vi.fn();
  const separator = () => container.querySelector<HTMLElement>('[data-testid="avatar-column-resizer"]')!;
  const mount = () => {
    root = createRoot(container);
    act(() => { root!.render(<ColumnResizer width={400} maxWidth={560} onResize={onResize} onCommit={onCommit} />); });
  };
  const pointer = (target: EventTarget, type: string, init: PointerEventInit) => act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init }));
  });
  const startDrag = () => pointer(separator(), 'pointerdown', { clientX: 500, buttons: 1 });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onResize.mockClear();
    onCommit.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    document.documentElement.classList.remove(CLASS);
  });

  test('dragging to the left widens the column and the release commits the width once', () => {
    mount();
    startDrag();
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    pointer(window, 'pointermove', { clientX: 450, buttons: 1 });
    expect(onResize).toHaveBeenLastCalledWith(450);
    pointer(window, 'pointerup', { clientX: 450, buttons: 0 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(450);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test('unmounting during a drag removes the window listeners and the resizing class', () => {
    mount();
    startDrag();
    pointer(window, 'pointermove', { clientX: 450, buttons: 1 });
    expect(onResize).toHaveBeenCalledTimes(1);
    act(() => { root!.unmount(); });
    root = null;
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
    // A later pointer event changes nothing: the listeners are gone.
    pointer(window, 'pointermove', { clientX: 300, buttons: 1 });
    pointer(window, 'pointerup', { clientX: 300, buttons: 0 });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(450);
  });

  test('a pointermove with no button held ends the drag and commits the width reached', () => {
    mount();
    startDrag();
    pointer(window, 'pointermove', { clientX: 450, buttons: 1 });
    pointer(window, 'pointermove', { clientX: 300, buttons: 0 });
    // Ended at the width reached before the free pointer, not followed to 300.
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(450);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
    pointer(window, 'pointermove', { clientX: 200, buttons: 0 });
    expect(onResize).toHaveBeenCalledTimes(1);
  });
});
