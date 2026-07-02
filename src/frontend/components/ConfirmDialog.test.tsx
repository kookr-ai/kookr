// @vitest-environment jsdom

import { act, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';

function flush() {
  return act(async () => {
    await Promise.resolve();
  });
}

interface RenderOptions {
  children?: ReactNode;
  footer?: ReactNode;
  onConfirm?: () => void;
  suppressEnterToConfirm?: boolean;
}

function Harness({ children, footer, onConfirm = vi.fn(), suppressEnterToConfirm }: RenderOptions) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <ConfirmDialog
          title="Delete task"
          message="This cannot be undone."
          confirmLabel="Delete"
          confirmClass="btn-danger"
          onConfirm={onConfirm}
          onClose={() => setOpen(false)}
          footer={footer}
          suppressEnterToConfirm={suppressEnterToConfirm}
        >
          {children}
        </ConfirmDialog>
      )}
    </>
  );
}

async function renderDialog(options: RenderOptions = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<Harness {...options} />);
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

function sendEnter(target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('ConfirmDialog focus management', () => {
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
    vi.restoreAllMocks();
  });

  test.each([
    ['plain dialog', {}],
    ['with children', { children: <a href="/details">Review details</a> }],
    ['with footer', { footer: <textarea aria-label="Completion note" /> }],
    [
      'with children, footer, and Enter suppression',
      {
        children: <input aria-label="Reason" />,
        footer: <button type="button">Footer action</button>,
        suppressEnterToConfirm: true,
      },
    ],
  ] satisfies Array<[string, RenderOptions]>)('focuses Cancel on open for %s', async (_name, options) => {
    const { container, root } = await renderDialog(options);
    roots.push(root);

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(buttonNamed(container, 'Cancel'));
  });

  test('wraps Tab and Shift+Tab between Cancel and Confirm in the plain dialog', async () => {
    const { container, root } = await renderDialog();
    roots.push(root);

    const cancel = buttonNamed(container, 'Cancel');
    const confirm = buttonNamed(container, 'Delete');

    confirm.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(cancel);
    expect(forwardWrap.defaultPrevented).toBe(true);

    cancel.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(confirm);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('does not prevent Tab while focus is inside the dialog boundary', async () => {
    const { container, root } = await renderDialog();
    roots.push(root);

    const cancel = buttonNamed(container, 'Cancel');

    cancel.focus();
    const interiorTab = sendTab();

    expect(interiorTab.defaultPrevented).toBe(false);
  });

  test('includes optional focusable children and footer content in the focus trap boundary', async () => {
    const { container, root } = await renderDialog({
      children: <a href="/details">Review details</a>,
      footer: <button type="button">Footer action</button>,
    });
    roots.push(root);

    const firstFocusable = container.querySelector<HTMLAnchorElement>('a[href="/details"]');
    const confirm = buttonNamed(container, 'Delete');

    confirm.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(firstFocusable);
    expect(forwardWrap.defaultPrevented).toBe(true);

    firstFocusable?.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(confirm);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('includes contenteditable children in the focus trap boundary', async () => {
    const { container, root } = await renderDialog({
      children: <div contentEditable="true" role="textbox">Editable</div>,
    });
    roots.push(root);

    const editable = container.querySelector<HTMLElement>('[contenteditable="true"]');
    const confirm = buttonNamed(container, 'Delete');

    confirm.focus();
    const forwardWrap = sendTab();

    expect(document.activeElement).toBe(editable);
    expect(forwardWrap.defaultPrevented).toBe(true);
  });

  test('wraps Shift+Tab from footer content when the footer is the first focusable element', async () => {
    const { container, root } = await renderDialog({
      footer: <button type="button">Footer action</button>,
    });
    roots.push(root);

    const footerAction = buttonNamed(container, 'Footer action');
    const confirm = buttonNamed(container, 'Delete');

    footerAction.focus();
    const backwardWrap = sendTab(true);

    expect(document.activeElement).toBe(confirm);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('moves focus back inside when Tab starts outside the dialog', async () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Outside';
    document.body.appendChild(outside);

    const { container, root } = await renderDialog();
    roots.push(root);

    outside.focus();
    expect(document.activeElement).toBe(outside);

    const escapedFocus = sendTab();

    expect(document.activeElement).toBe(buttonNamed(container, 'Cancel'));
    expect(escapedFocus.defaultPrevented).toBe(true);
  });

  test('restores focus to the opener when closed', async () => {
    const { container, root, opener } = await renderDialog();
    roots.push(root);

    await act(async () => {
      buttonNamed(container, 'Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('lets the focused Cancel button keep native Enter behavior', async () => {
    const onConfirm = vi.fn();
    const { container, root } = await renderDialog({ onConfirm });
    roots.push(root);

    const cancel = buttonNamed(container, 'Cancel');
    expect(document.activeElement).toBe(cancel);

    const enter = sendEnter(cancel);

    expect(enter.defaultPrevented).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test.each([
    ['link', <a href="/details">Review details</a>, 'a[href="/details"]'],
    ['input', <input aria-label="Reason" />, 'input[aria-label="Reason"]'],
    ['textarea', <textarea aria-label="Completion note" />, 'textarea[aria-label="Completion note"]'],
    ['select', <select aria-label="Choice"><option>One</option></select>, 'select[aria-label="Choice"]'],
    ['contenteditable', <div contentEditable="true" role="textbox">Editable</div>, '[contenteditable="true"]'],
  ] satisfies Array<[string, ReactNode, string]>)('lets %s targets keep native Enter behavior', async (_name, control, selector) => {
    const onConfirm = vi.fn();
    const { container, root } = await renderDialog({ children: control, onConfirm });
    roots.push(root);

    const target = container.querySelector<HTMLElement>(selector);
    expect(target).not.toBeNull();

    target!.focus();
    const enter = sendEnter(target!);

    expect(enter.defaultPrevented).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('keeps the global Enter-to-confirm shortcut outside native controls', async () => {
    const onConfirm = vi.fn();
    const { root } = await renderDialog({ onConfirm });
    roots.push(root);

    const enter = sendEnter();

    expect(enter.defaultPrevented).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('suppresses the global Enter-to-confirm shortcut when requested', async () => {
    const onConfirm = vi.fn();
    const { root } = await renderDialog({ onConfirm, suppressEnterToConfirm: true });
    roots.push(root);

    const enter = sendEnter();

    expect(enter.defaultPrevented).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('does not advertise Enter confirm while Cancel receives initial focus', async () => {
    const { container, root } = await renderDialog();
    roots.push(root);

    const hint = container.querySelector('.confirm-dialog-hint');
    expect(hint?.textContent).toBe('Esc cancel');
  });
});
