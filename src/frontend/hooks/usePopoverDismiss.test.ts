// @vitest-environment happy-dom

import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { usePopoverDismiss } from './usePopoverDismiss.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  usePopoverDismiss(open, onClose, popoverRef, triggerRef);
  return React.createElement(
    'div',
    null,
    React.createElement('button', { ref: triggerRef, id: 'trigger' }, 'open'),
    React.createElement('div', { ref: popoverRef, id: 'popover' }, React.createElement('span', { id: 'inside' }, 'x')),
    React.createElement('p', { id: 'outside' }, 'elsewhere'),
  );
}

function mount(open: boolean, onClose: () => void): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(Harness, { open, onClose }));
  });
}

function press(id: string): void {
  act(() => {
    document.getElementById(id)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('usePopoverDismiss', () => {
  test('Escape closes the popover and returns focus to its trigger', () => {
    const onClose = vi.fn();
    mount(true, onClose);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement?.id).toBe('trigger');
  });

  test('a press outside closes it; a press inside the popover or on the trigger does not', () => {
    const onClose = vi.fn();
    mount(true, onClose);
    press('inside');
    press('trigger');
    expect(onClose).not.toHaveBeenCalled();
    press('outside');
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('does nothing while closed', () => {
    const onClose = vi.fn();
    mount(false, onClose);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    press('outside');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('other keys are ignored', () => {
    const onClose = vi.fn();
    mount(true, onClose);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
