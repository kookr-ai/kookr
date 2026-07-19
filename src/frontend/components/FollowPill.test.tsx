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
});
