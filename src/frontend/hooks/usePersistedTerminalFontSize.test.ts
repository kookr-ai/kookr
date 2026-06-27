// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STORAGE_KEY,
  usePersistedTerminalFontSize,
} from './usePersistedTerminalFontSize.js';

interface Captured {
  fontSize: number;
  setFontSize: React.Dispatch<React.SetStateAction<number>>;
}

function mount(): { container: HTMLDivElement; root: Root; captured: Captured } {
  const captured = {
    fontSize: DEFAULT_TERMINAL_FONT_SIZE,
    setFontSize: () => {},
  } as Captured;

  function Probe() {
    const [fontSize, setFontSize] = usePersistedTerminalFontSize();
    captured.fontSize = fontSize;
    captured.setFontSize = setFontSize;
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

describe('usePersistedTerminalFontSize', () => {
  let teardowns: Array<() => void>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    teardowns = [];
  });

  afterEach(() => {
    for (const teardown of teardowns) teardown();
    document.body.innerHTML = '';
  });

  function trackTeardown(root: Root, container: HTMLDivElement) {
    teardowns.push(() => {
      act(() => root.unmount());
      container.remove();
    });
  }

  test('returns the default when no value is stored', () => {
    const { root, container, captured } = mount();
    trackTeardown(root, container);

    expect(captured.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  test('returns a valid stored font size', () => {
    localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, '17');
    const { root, container, captured } = mount();
    trackTeardown(root, container);

    expect(captured.fontSize).toBe(17);
  });

  test('clamps stored font sizes to the supported range', () => {
    localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, '100');
    const high = mount();
    trackTeardown(high.root, high.container);
    expect(high.captured.fontSize).toBe(MAX_TERMINAL_FONT_SIZE);

    localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, '1');
    const low = mount();
    trackTeardown(low.root, low.container);
    expect(low.captured.fontSize).toBe(MIN_TERMINAL_FONT_SIZE);
  });

  test('returns the default for malformed stored values', () => {
    localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, 'abc');
    const { root, container, captured } = mount();
    trackTeardown(root, container);

    expect(captured.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  test('returns the default when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const { root, container, captured } = mount();
      trackTeardown(root, container);
      expect(captured.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    } finally {
      spy.mockRestore();
    }
  });

  test('setter clamps and persists direct and functional updates', () => {
    const { root, container, captured } = mount();
    trackTeardown(root, container);

    act(() => captured.setFontSize(100));
    expect(captured.fontSize).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBe(String(MAX_TERMINAL_FONT_SIZE));

    act(() => captured.setFontSize((current) => current - 100));
    expect(captured.fontSize).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBe(String(MIN_TERMINAL_FONT_SIZE));
  });

  test('setter still updates state when localStorage.setItem throws', () => {
    const { root, container, captured } = mount();
    trackTeardown(root, container);

    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      act(() => captured.setFontSize(18));
      expect(captured.fontSize).toBe(18);
    } finally {
      spy.mockRestore();
    }
  });
});
