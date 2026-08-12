// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { formatYieldRate, LessonYieldPanel } from './LessonYieldPanel.js';
import type { LessonYieldStatus } from '../store/store-types.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

let root: Root | null = null;
let container: HTMLDivElement;

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function fixture(overrides: Partial<LessonYieldStatus> = {}): LessonYieldStatus {
  return {
    windowDays: 1,
    yieldRate: 0.75,
    decided: 3,
    completedInWindow: 4,
    buckets: {
      wroteLesson: 2,
      explicitSkip: 1,
      searchOnly: 0,
      noKbActivity: 1,
    },
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  syncGlobalStore();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe('formatYieldRate', () => {
  test('formats rates to two decimals, collapsing zero and clamping negatives', () => {
    expect(formatYieldRate(0)).toBe('0');
    expect(formatYieldRate(0.75)).toBe('0.75');
    expect(formatYieldRate(1)).toBe('1.00');
    expect(formatYieldRate(-1)).toBe('0');
    expect(formatYieldRate(Number.NaN)).toBe('0');
  });
});

describe('LessonYieldPanel', () => {
  test('renders yield rate, decided denominator, and bucket counts from a fixture', () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(LessonYieldPanel, { snapshot: fixture() }));
    });

    expect(container.textContent).toContain('Lesson Yield');
    expect(container.textContent).toContain('rate 0.75');
    expect(container.textContent).toContain('rate=0.75');
    expect(container.textContent).toContain('decided=3/4');
    expect(container.textContent).toContain('wrote=2');
    expect(container.textContent).toContain('skip=1');
    expect(container.textContent).toContain('searchOnly=0');
    expect(container.textContent).toContain('noKb=1');
    expect(container.textContent).toContain('1d window');
    // Below target: completions exist and yieldRate < 1.
    expect(container.textContent).toContain('below target');
  });

  test('renders an all-zero block without the below-target pill', () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(LessonYieldPanel, {
        snapshot: fixture({
          yieldRate: 0,
          decided: 0,
          completedInWindow: 0,
          buckets: { wroteLesson: 0, explicitSkip: 0, searchOnly: 0, noKbActivity: 0 },
        }),
      }));
    });

    expect(container.textContent).toContain('rate 0');
    expect(container.textContent).toContain('decided=0/0');
    expect(container.textContent).not.toContain('below target');
  });

  test('omits the below-target pill when yield meets target', () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(LessonYieldPanel, {
        snapshot: fixture({ yieldRate: 1, decided: 4, completedInWindow: 4 }),
      }));
    });

    expect(container.textContent).toContain('rate 1.00');
    expect(container.textContent).not.toContain('below target');
  });

  test('shows a muted empty state when the block is missing', () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(LessonYieldPanel, { snapshot: null }));
    });

    expect(container.textContent).toContain('Lesson Yield');
    expect(container.textContent).toContain('no data');
    expect(container.textContent).toContain('No lesson yield data yet.');
    expect(container.textContent).not.toContain('below target');
  });

  test('collapses and expands the card body when the header is toggled', () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(LessonYieldPanel, { snapshot: fixture() }));
    });

    const header = container.querySelector<HTMLButtonElement>('.lesson-yield-header');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('#lesson-yield-body')).not.toBeNull();
    expect(container.textContent).toContain('decided=3/4');

    act(() => header?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#lesson-yield-body')).toBeNull();
    expect(container.textContent).not.toContain('decided=3/4');

    act(() => header?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('decided=3/4');
  });

  test('reads the projection from the ops-health store', () => {
    useKookrStore.getState().handleOpsHealth({ lessonYield: fixture() });

    act(() => {
      root = createRoot(container);
      root.render(React.createElement(LessonYieldPanel));
    });

    expect(container.textContent).toContain('decided=3/4');
    expect(container.textContent).toContain('wrote=2');
  });
});
