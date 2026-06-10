// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePersistedCollapsed, useAutoExpandOnItemGain } from './usePersistedCollapsed.js';

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

interface AutoExpandCaptured {
  collapsed: boolean;
  toggle: () => void;
}

function mountAutoExpand(key: string, defaultCollapsed: boolean, initialCount: number): {
  container: HTMLDivElement;
  root: Root;
  captured: AutoExpandCaptured;
  setCount: (count: number) => void;
} {
  const captured = { collapsed: false, toggle: () => {} } as AutoExpandCaptured;

  function Probe({ count }: { count: number }) {
    const [collapsed, toggle, expand] = usePersistedCollapsed(key, defaultCollapsed);
    useAutoExpandOnItemGain(count, expand);
    captured.collapsed = collapsed;
    captured.toggle = toggle;
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const setCount = (count: number) => {
    act(() => {
      root.render(React.createElement(Probe, { count }));
    });
  };
  setCount(initialCount);
  return { container, root, captured, setCount };
}

describe('usePersistedCollapsed expand setter', () => {
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

  test('expand un-collapses and persists "0"', () => {
    const captured = { collapsed: false, toggle: () => {}, expand: () => {} };

    function Probe() {
      const [collapsed, toggle, expand] = usePersistedCollapsed('kookr:test.expand', true);
      captured.collapsed = collapsed;
      captured.toggle = toggle;
      captured.expand = expand;
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(Probe));
    });
    trackTeardown(root, container);

    expect(captured.collapsed).toBe(true);
    act(() => captured.expand());
    expect(captured.collapsed).toBe(false);
    expect(localStorage.getItem('kookr:test.expand')).toBe('0');
  });

  test('expand is a no-op (no storage write) when already expanded', () => {
    const captured = { collapsed: false, expand: () => {} };

    function Probe() {
      const [collapsed, , expand] = usePersistedCollapsed('kookr:test.expand2', false);
      captured.collapsed = collapsed;
      captured.expand = expand;
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(Probe));
    });
    trackTeardown(root, container);

    act(() => captured.expand());
    expect(captured.collapsed).toBe(false);
    expect(localStorage.getItem('kookr:test.expand2')).toBeNull();
  });
});

describe('useAutoExpandOnItemGain (F19)', () => {
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

  test('collapsed group expands when its item count increases (0 → N)', () => {
    localStorage.setItem('kookr:test.gain', '1'); // user previously collapsed
    const { root, container, captured, setCount } = mountAutoExpand('kookr:test.gain', false, 0);
    trackTeardown(root, container);

    expect(captured.collapsed).toBe(true);
    setCount(2); // new items arrive
    expect(captured.collapsed).toBe(false);
    expect(localStorage.getItem('kookr:test.gain')).toBe('0');
  });

  test('persisted collapsed preference survives a mount that already has items (no false "arrival")', () => {
    localStorage.setItem('kookr:test.gain-mount', '1');
    const { root, container, captured, setCount } = mountAutoExpand('kookr:test.gain-mount', false, 3);
    trackTeardown(root, container);

    // Items present at mount are the baseline, not new arrivals — the user's
    // stored preference wins (and is not overwritten in storage)…
    expect(captured.collapsed).toBe(true);
    expect(localStorage.getItem('kookr:test.gain-mount')).toBe('1');

    // …but a post-mount gain still pops the section open.
    setCount(4);
    expect(captured.collapsed).toBe(false);
  });

  test('manual re-collapse sticks across re-renders with a stable or shrinking count', () => {
    const { root, container, captured, setCount } = mountAutoExpand('kookr:test.stick', false, 1);
    trackTeardown(root, container);
    setCount(2); // post-mount arrival triggers the auto-expand
    expect(captured.collapsed).toBe(false);

    act(() => captured.toggle()); // user re-collapses after the auto-expand
    expect(captured.collapsed).toBe(true);

    setCount(2); // re-render, same count — must NOT re-expand
    expect(captured.collapsed).toBe(true);

    setCount(1); // shrinking count — must NOT re-expand
    expect(captured.collapsed).toBe(true);
  });

  test('a NEW arrival after a manual re-collapse expands again', () => {
    const { root, container, captured, setCount } = mountAutoExpand('kookr:test.rearrive', false, 1);
    trackTeardown(root, container);

    act(() => captured.toggle());
    expect(captured.collapsed).toBe(true);

    setCount(2); // count increases — a new thing is waiting on the user
    expect(captured.collapsed).toBe(false);
  });
});
