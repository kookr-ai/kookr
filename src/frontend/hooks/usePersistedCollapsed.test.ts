// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePersistedCollapsed } from './usePersistedCollapsed.js';

interface Captured {
  collapsed: boolean;
  toggle: () => void;
}

function mount(key: string, defaultCollapsed: boolean): { container: HTMLDivElement; root: Root; captured: Captured } {
  const captured = { collapsed: false, toggle: () => {} } as Captured;

  function Probe() {
    const [collapsed, toggle] = usePersistedCollapsed(key, defaultCollapsed);
    captured.collapsed = collapsed;
    captured.toggle = toggle;
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Probe));
  });
  return { container, root, captured };
}

describe('usePersistedCollapsed', () => {
  let teardowns: Array<() => void>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    teardowns = [];
  });

  afterEach(() => {
    for (const t of teardowns) t();
    document.body.innerHTML = '';
  });

  function trackTeardown(root: Root, container: HTMLDivElement) {
    teardowns.push(() => {
      act(() => root.unmount());
      container.remove();
    });
  }

  test('returns default when no value is stored', () => {
    const { root, container, captured } = mount('kookr:test.a', true);
    trackTeardown(root, container);
    expect(captured.collapsed).toBe(true);

    const r2 = mount('kookr:test.b', false);
    trackTeardown(r2.root, r2.container);
    expect(r2.captured.collapsed).toBe(false);
  });

  test('returns collapsed when stored value is "1"', () => {
    localStorage.setItem('kookr:test.a', '1');
    const { root, container, captured } = mount('kookr:test.a', false);
    trackTeardown(root, container);
    expect(captured.collapsed).toBe(true);
  });

  test('returns expanded when stored value is "0"', () => {
    localStorage.setItem('kookr:test.a', '0');
    const { root, container, captured } = mount('kookr:test.a', true);
    trackTeardown(root, container);
    expect(captured.collapsed).toBe(false);
  });

  test('returns default when stored value is malformed', () => {
    localStorage.setItem('kookr:test.a', 'true');
    const { root, container, captured } = mount('kookr:test.a', true);
    trackTeardown(root, container);
    expect(captured.collapsed).toBe(true);

    localStorage.setItem('kookr:test.b', 'yes');
    const r2 = mount('kookr:test.b', false);
    trackTeardown(r2.root, r2.container);
    expect(r2.captured.collapsed).toBe(false);
  });

  test('toggle flips the value and writes "1" / "0" to localStorage', () => {
    const { root, container, captured } = mount('kookr:test.a', false);
    trackTeardown(root, container);

    act(() => captured.toggle());
    expect(captured.collapsed).toBe(true);
    expect(localStorage.getItem('kookr:test.a')).toBe('1');

    act(() => captured.toggle());
    expect(captured.collapsed).toBe(false);
    expect(localStorage.getItem('kookr:test.a')).toBe('0');
  });

  test('falls back to default when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const { root, container, captured } = mount('kookr:test.a', true);
      trackTeardown(root, container);
      expect(captured.collapsed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('toggle still updates state when localStorage.setItem throws', () => {
    const { root, container, captured } = mount('kookr:test.a', false);
    trackTeardown(root, container);

    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      act(() => captured.toggle());
      expect(captured.collapsed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
