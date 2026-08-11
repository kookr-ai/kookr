// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getDefaultShortcutBindings,
  resolveShortcutBindings,
  type ShortcutBindingMap,
} from '../../shared/contracts/shortcut-bindings.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { FollowPill } from './FollowPill.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

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

describe('FollowPill', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function render(shortcutBindings?: ShortcutBindingMap) {
    act(() => {
      root.render(React.createElement(FollowPill, shortcutBindings ? { shortcutBindings } : {}));
    });
  }

  function followButton(): HTMLButtonElement {
    const btn = container.querySelector<HTMLButtonElement>('.follow-pill');
    if (!btn) throw new Error('FollowPill button missing');
    return btn;
  }

  function caretButton(): HTMLButtonElement {
    const btn = container.querySelector<HTMLButtonElement>('.follow-pill-caret');
    if (!btn) throw new Error('FollowPill caret missing');
    return btn;
  }

  function detailsDialog(): HTMLElement {
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Auto-Advance details"]');
    if (!dialog) throw new Error('Auto-Advance details dialog missing');
    return dialog;
  }

  function actionButton(): HTMLButtonElement {
    const btn = container.querySelector<HTMLButtonElement>('.follow-pill-menu-item');
    if (!btn) throw new Error('Auto-Advance action button missing');
    return btn;
  }

  async function openDetails() {
    const caret = caretButton();
    caret.focus();
    await act(async () => {
      caret.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    return caret;
  }

  test('mac defaults show Cmd+Ctrl+F, not Alt+F', () => {
    render(getDefaultShortcutBindings('mac'));

    const label = followButton().getAttribute('aria-label') ?? '';
    expect(label).toContain('Cmd+Ctrl+F');
    expect(label).not.toContain('Alt+F');
    expect(followButton().getAttribute('title')).toBe(label);
  });

  test('default platform shows Alt+F', () => {
    render(getDefaultShortcutBindings('default'));

    const label = followButton().getAttribute('aria-label') ?? '';
    expect(label).toContain('Alt+F');
    expect(label).not.toContain('Cmd+Ctrl+F');
  });

  test('rebinding toggle_auto_advance is reflected in tooltip and aria-label', () => {
    const rebound = resolveShortcutBindings('default', {
      toggle_auto_advance: 'Ctrl+Shift+F',
    });
    render(rebound);

    const label = followButton().getAttribute('aria-label') ?? '';
    expect(label).toContain('Ctrl+Shift+F');
    expect(label).not.toContain('Alt+F');
    expect(followButton().getAttribute('title')).toContain('Ctrl+Shift+F');
  });

  test('enabled vs disabled copy both include the resolved shortcut', () => {
    const mac = getDefaultShortcutBindings('mac');
    act(() => {
      useKookrStore.setState({ autoAdvanceEnabled: false });
    });
    render(mac);
    expect(followButton().getAttribute('aria-label')).toMatch(
      /Auto-Advance is off\. Press Cmd\+Ctrl\+F/,
    );

    act(() => {
      useKookrStore.setState({ autoAdvanceEnabled: true });
    });
    render(mac);
    expect(followButton().getAttribute('aria-label')).toMatch(
      /Press Cmd\+Ctrl\+F to turn off/,
    );
  });

  test('opening Auto-Advance details focuses the action button inside the dialog', async () => {
    render();
    await openDetails();

    expect(detailsDialog()).toBeTruthy();
    expect(document.activeElement).toBe(actionButton());
  });

  test('Tab wraps within the details dialog while open', async () => {
    render();
    await openDetails();

    const action = actionButton();
    expect(document.activeElement).toBe(action);

    // Sole focusable: Tab and Shift+Tab both wrap back onto the action button.
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(action);
    expect(forwardWrap.defaultPrevented).toBe(true);

    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(action);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('Tab from outside the open dialog pulls focus back inside', async () => {
    render();
    await openDetails();

    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const escapedFocus = sendTab();
    expect(document.activeElement).toBe(actionButton());
    expect(escapedFocus.defaultPrevented).toBe(true);
  });

  test('Escape closes the dialog and restores focus to the caret', async () => {
    render();
    const caret = await openDetails();
    expect(detailsDialog()).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });
    await flush();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(caret);
  });

  test('toggling the caret closed restores focus to the caret', async () => {
    render();
    const caret = await openDetails();
    expect(detailsDialog()).toBeTruthy();

    await act(async () => {
      caret.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(caret);
  });

  test('outside click closes the dialog', async () => {
    render();
    await openDetails();
    expect(detailsDialog()).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
