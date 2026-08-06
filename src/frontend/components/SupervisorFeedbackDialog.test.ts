// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SupervisorFeedbackDialog } from './SupervisorFeedbackDialog.js';

describe('SupervisorFeedbackDialog', () => {
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

  function setValue(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findSubmitButton(): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const submit = buttons.find((b) => b.textContent === 'Not a real issue' || b.textContent === 'Missed a real issue');
    if (!submit) throw new Error('submit button not found');
    return submit;
  }

  function sendTab(shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  test('FP mode allows submitting with empty reason and omits userReason in payload', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-1',
        supervisorExplanation: 'Agent is waiting for input',
        onSubmit,
        onClose: vi.fn(),
      }));
    });

    const submit = findSubmitButton();
    expect(submit.disabled).toBe(false);

    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ userReason: '' });
  });

  test('FN mode requires a non-empty reason before enabling submit', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_negative',
        agentName: 'agent-2',
        onSubmit,
        onClose: vi.fn(),
      }));
    });

    const submit = findSubmitButton();
    expect(submit.disabled).toBe(true);

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => setValue(textarea, '   '));
    expect(submit.disabled).toBe(true);

    await act(async () => setValue(textarea, 'agent stuck for 10m'));
    expect(submit.disabled).toBe(false);

    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ userReason: 'agent stuck for 10m' });
  });

  test('FN mode includes suspectedType when selected', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_negative',
        agentName: 'agent-3',
        onSubmit,
        onClose: vi.fn(),
      }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const select = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => setValue(textarea, 'visibly stuck'));
    await act(async () => setValue(select, 'stale_agent'));

    const submit = findSubmitButton();
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({
      userReason: 'visibly stuck',
      suspectedType: 'stale_agent',
    });
  });

  test('FN mode omits suspectedType when left at "don\'t know"', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_negative',
        agentName: 'agent-4',
        onSubmit,
        onClose: vi.fn(),
      }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => setValue(textarea, 'something off'));

    await act(async () => {
      findSubmitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const arg = onSubmit.mock.calls[0]![0] as { userReason: string; suspectedType?: string };
    expect(arg.userReason).toBe('something off');
    expect('suspectedType' in arg).toBe(false);
  });

  test('Ctrl+Enter submits when valid', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_negative',
        agentName: 'agent-5',
        onSubmit,
        onClose: vi.fn(),
      }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => setValue(textarea, 'real reason'));
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ userReason: 'real reason' });
  });

  test('clicking overlay calls onClose and stops propagation', async () => {
    const onClose = vi.fn();
    const parentClick = vi.fn();
    const parent = document.createElement('div');
    parent.addEventListener('click', parentClick);
    document.body.appendChild(parent);
    parent.appendChild(container);

    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-6',
        onSubmit: vi.fn(),
        onClose,
      }));
    });

    const overlay = container.querySelector<HTMLDivElement>('.dialog-overlay')!;
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  test('clicking inside the dialog does not close it', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-7',
        onSubmit: vi.fn(),
        onClose,
      }));
    });

    const dialog = container.querySelector<HTMLDivElement>('.supervisor-feedback-dialog')!;
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  test('Escape closes the dialog', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-8',
        onSubmit: vi.fn(),
        onClose,
      }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalled();
  });

  test('initial focus lands on the textarea', async () => {
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-focus',
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(document.activeElement).toBe(textarea);
  });

  test('Tab from the last focusable wraps to the first, and Shift+Tab wraps back', async () => {
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-trap',
        supervisorExplanation: 'context',
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    // In FP mode the submit button is always enabled, so it is the last focusable.
    const submit = findSubmitButton();
    expect(submit.disabled).toBe(false);

    submit.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(textarea);
    expect(forwardWrap.defaultPrevented).toBe(true);

    textarea.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(submit);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('pulls focus back inside when Tab starts outside the dialog', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.appendChild(outside);

    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-escape-focus',
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }));
    });

    outside.focus();
    expect(document.activeElement).toBe(outside);

    const escapedFocus = sendTab();
    expect(container.querySelector('.supervisor-feedback-dialog')!.contains(document.activeElement)).toBe(true);
    expect(escapedFocus.defaultPrevented).toBe(true);

    outside.remove();
  });

  test('restores focus to the opener when the dialog is unmounted', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open feedback';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-restore',
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }));
    });
    expect(document.activeElement).toBe(container.querySelector('textarea'));

    await act(async () => root.unmount());
    expect(document.activeElement).toBe(opener);

    // Re-arm the root so the shared afterEach unmount stays a no-op.
    root = createRoot(container);
    opener.remove();
  });

  test('FP mode renders supervisor explanation; FN mode does not', async () => {
    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_positive',
        agentName: 'agent-9',
        supervisorExplanation: 'Specific supervisor text',
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }));
    });
    expect(container.textContent).toContain('Specific supervisor text');
    expect(container.querySelector('select')).toBeNull();

    await act(async () => {
      root.render(React.createElement(SupervisorFeedbackDialog, {
        mode: 'false_negative',
        agentName: 'agent-10',
        supervisorExplanation: 'should not appear',
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }));
    });
    expect(container.textContent).not.toContain('should not appear');
    expect(container.querySelector('select')).not.toBeNull();
  });
});
