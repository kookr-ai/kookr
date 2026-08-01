// @vitest-environment jsdom

import React, { act, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { useDialogFocus } from './useDialogFocus.js';

function flush() {
  return act(async () => {
    await Promise.resolve();
  });
}

function sendTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

interface HarnessProps {
  open: boolean;
  initialFocus?: 'cancel' | 'confirm' | 'none';
  extra?: ReactNode;
}

function FocusHarness({ open, initialFocus = 'cancel', extra }: HarnessProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef =
    initialFocus === 'cancel' ? cancelRef
      : initialFocus === 'confirm' ? confirmRef
        : undefined;

  useDialogFocus({
    dialogRef,
    initialFocusRef,
  });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
    >
      {extra}
      <button ref={cancelRef} type="button">Cancel</button>
      <button ref={confirmRef} type="button">Confirm</button>
    </div>
  );
}

function OpenableHarness({
  initialFocus = 'cancel',
  extra,
}: {
  initialFocus?: 'cancel' | 'confirm' | 'none';
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <FocusHarness open initialFocus={initialFocus} extra={extra} />
      )}
      {open && (
        <button type="button" onClick={() => setOpen(false)}>Close dialog</button>
      )}
    </>
  );
}

async function renderOpenable(options: {
  initialFocus?: 'cancel' | 'confirm' | 'none';
  extra?: ReactNode;
} = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<OpenableHarness {...options} />);
  });

  const opener = buttonNamed(container, 'Open dialog');
  opener.focus();
  await act(async () => {
    opener.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();

  return { container, root, opener };
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
}

describe('useDialogFocus', () => {
  let roots: Root[] = [];

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = '';
  });

  test('focuses the initialFocusRef element on open', async () => {
    const { container, root } = await renderOpenable({ initialFocus: 'cancel' });
    roots.push(root);

    expect(document.activeElement).toBe(buttonNamed(container, 'Cancel'));
  });

  test('falls back to the first focusable element when initialFocusRef is omitted', async () => {
    const { container, root } = await renderOpenable({
      initialFocus: 'none',
      extra: <a href="/details">Review details</a>,
    });
    roots.push(root);

    expect(document.activeElement).toBe(container.querySelector('a[href="/details"]'));
  });

  test('wraps Tab from last focusable to first', async () => {
    const { container, root } = await renderOpenable();
    roots.push(root);

    const cancel = buttonNamed(container, 'Cancel');
    const confirm = buttonNamed(container, 'Confirm');

    confirm.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(cancel);
    expect(forwardWrap.defaultPrevented).toBe(true);
  });

  test('wraps Shift+Tab from first focusable to last', async () => {
    const { container, root } = await renderOpenable();
    roots.push(root);

    const cancel = buttonNamed(container, 'Cancel');
    const confirm = buttonNamed(container, 'Confirm');

    cancel.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(confirm);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('does not prevent Tab while focus is inside the dialog boundary', async () => {
    const { container, root } = await renderOpenable();
    roots.push(root);

    buttonNamed(container, 'Cancel').focus();
    const interiorTab = sendTab();

    expect(interiorTab.defaultPrevented).toBe(false);
  });

  test('moves focus back inside when Tab starts outside the dialog', async () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Outside';
    document.body.appendChild(outside);

    const { container, root } = await renderOpenable();
    roots.push(root);

    outside.focus();
    expect(document.activeElement).toBe(outside);

    const escapedFocus = sendTab();
    expect(document.activeElement).toBe(buttonNamed(container, 'Cancel'));
    expect(escapedFocus.defaultPrevented).toBe(true);
  });

  test('restores focus to the opener on unmount', async () => {
    const { container, root, opener } = await renderOpenable();
    roots.push(root);

    await act(async () => {
      buttonNamed(container, 'Close dialog').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('includes extra focusable children in the Tab cycle boundary', async () => {
    const { container, root } = await renderOpenable({
      extra: <a href="/details">Review details</a>,
    });
    roots.push(root);

    const first = container.querySelector<HTMLAnchorElement>('a[href="/details"]');
    const confirm = buttonNamed(container, 'Confirm');

    confirm.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(first);
    expect(forwardWrap.defaultPrevented).toBe(true);

    first?.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(confirm);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });
});
