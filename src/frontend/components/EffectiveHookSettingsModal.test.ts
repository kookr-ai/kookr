// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EffectiveHookSettingsModal } from './EffectiveHookSettingsModal.js';

vi.mock('../api/index.js', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  getEffectiveHookSettings: vi.fn(() => Promise.resolve({
    content: { hooks: {} },
    agentType: 'claude-code',
    settingsPath: '/tmp/settings.json',
  })),
}));

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

function focusablesInDialog(container: HTMLElement): HTMLElement[] {
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) return [];
  const selector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');
  return Array.from(dialog.querySelectorAll<HTMLElement>(selector));
}

describe('EffectiveHookSettingsModal focus management', () => {
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
    vi.clearAllMocks();
  });

  test('initial focus lands on the header close button', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(EffectiveHookSettingsModal, {
        sessionId: 'sess-1',
        onClose,
      }));
    });

    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(close).not.toBeNull();
    expect(document.activeElement).toBe(close);
  });

  test('Tab from last focusable cycles to first; Shift+Tab from first cycles to last', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(EffectiveHookSettingsModal, {
        sessionId: 'sess-trap',
        onClose,
      }));
    });

    const focusables = focusablesInDialog(container);
    // Header close (aria-label Close) + footer Close button.
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(first);
    expect(forwardWrap.defaultPrevented).toBe(true);

    first.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(last);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('Escape still closes the modal', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(EffectiveHookSettingsModal, {
        sessionId: 'sess-esc',
        onClose,
      }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalled();
  });
});
