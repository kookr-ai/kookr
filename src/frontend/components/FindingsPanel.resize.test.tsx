// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';
import {
  BOTTOM_SECTIONS_HEIGHT_KEY,
  MIN_BOTTOM_SECTIONS_HEIGHT,
} from '../store/bottom-sections-height-prefs.js';

// jsdom returns a zero-size rect for every element, which would pin the live
// `maxAvailable()` clamp (panel height − 160 reserve) to the minimum and make
// direction-dependent assertions indistinguishable. Give the panel a real
// height so ArrowUp/ArrowDown and drag deltas produce distinct, asserted values.
function stubPanelHeight(container: HTMLElement, height: number): void {
  const panel = container.querySelector('.findings-panel') as HTMLElement;
  panel.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 400, bottom: height, width: 400, height,
    toJSON() { return {}; },
  }) as DOMRect;
}

function storedHeight(): number | null {
  const raw = localStorage.getItem(BOTTOM_SECTIONS_HEIGHT_KEY);
  return raw == null ? null : Number(raw);
}

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeHealthy(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-h',
    taskId: overrides.taskId ?? 'task-h',
    taskName: overrides.taskName ?? 'A healthy task',
    description: 'Working',
    events: [],
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    startedAt: '2026-06-11T08:00:00Z',
    ...overrides,
  } as AgentState;
}

function renderPanel(container: HTMLElement, healthy: AgentState[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render((
      <FindingsPanel
        findings={[]}
        healthy={healthy}
        pending={[]}
        snoozed={[]}
        completed={[]}
        selectedAgentId={null}
        send={vi.fn()}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
      />
    ));
  });
  return root;
}

describe('bottom-sections resize handle', () => {
  let container: HTMLElement;
  let root: Root | null = null;

  beforeEach(() => {
    syncGlobalStore();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    localStorage.clear();
  });

  test('renders a resize separator when bottom sections have content', () => {
    root = renderPanel(container, [makeHealthy()]);
    const resizer = container.querySelector('[data-testid="bottom-sections-resizer"]');
    expect(resizer).toBeTruthy();
    expect(resizer?.getAttribute('role')).toBe('separator');
    expect(resizer?.getAttribute('aria-orientation')).toBe('horizontal');
  });

  test('is absent when there are no bottom sections', () => {
    root = renderPanel(container, []);
    expect(container.querySelector('[data-testid="bottom-sections-resizer"]')).toBeNull();
  });

  test('keyboard adjusts height by direction and persists each change', () => {
    // Seed a mid-range height so ArrowUp/ArrowDown move in opposite directions
    // within the [MIN, panelHeight-160] range rather than both pinning to a bound.
    localStorage.setItem(BOTTOM_SECTIONS_HEIGHT_KEY, '300');
    root = renderPanel(container, [makeHealthy()]);
    stubPanelHeight(container, 1000); // live max = 1000 - 160 = 840
    const resizer = container.querySelector('[data-testid="bottom-sections-resizer"]') as HTMLElement;
    const key = (init: KeyboardEventInit) =>
      act(() => { resizer.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });

    key({ key: 'ArrowUp' });
    expect(storedHeight()).toBe(316); // +16

    key({ key: 'ArrowDown' });
    expect(storedHeight()).toBe(300); // −16, back to start

    key({ key: 'ArrowUp', shiftKey: true });
    expect(storedHeight()).toBe(348); // +48 coarse step

    key({ key: 'Home' });
    expect(storedHeight()).toBe(MIN_BOTTOM_SECTIONS_HEIGHT); // floor

    key({ key: 'End' });
    expect(storedHeight()).toBe(840); // live max ceiling

    const bottom = container.querySelector('.bottom-sections') as HTMLElement;
    expect(bottom.classList.contains('bottom-sections-resized')).toBe(true);
    expect(bottom.style.maxHeight).toBe('none');
  });

  test('pointer drag up grows the sections by the drag delta and persists on release', () => {
    localStorage.setItem(BOTTOM_SECTIONS_HEIGHT_KEY, '300');
    root = renderPanel(container, [makeHealthy()]);
    stubPanelHeight(container, 1000);
    const resizer = container.querySelector('[data-testid="bottom-sections-resizer"]') as HTMLElement;

    // Press on the handle at y=500, drag up to y=380 (−120 → +120 height), release.
    act(() => { resizer.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 500 } as MouseEventInit)); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientY: 380 } as MouseEventInit)); });
    const bottom = container.querySelector('.bottom-sections') as HTMLElement;
    expect(bottom.style.height).toBe('420px'); // 300 + (500 − 380), live during drag
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientY: 380 } as MouseEventInit)); });
    expect(storedHeight()).toBe(420); // committed on release

    // A non-primary button is ignored (no drag started, height unchanged).
    act(() => { resizer.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2, clientY: 500 } as MouseEventInit)); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientY: 100 } as MouseEventInit)); });
    expect(bottom.style.height).toBe('420px');
  });

  test('does not apply a persisted height to an empty reserved placeholder', () => {
    localStorage.setItem(BOTTOM_SECTIONS_HEIGHT_KEY, '300');
    root = renderPanel(container, []); // no bottom sections at all
    const bottom = container.querySelector('.bottom-sections') as HTMLElement;
    expect(bottom.classList.contains('bottom-sections-reserved')).toBe(true);
    expect(bottom.classList.contains('bottom-sections-resized')).toBe(false);
    expect(bottom.style.height).toBe('');
  });

  test('applies a previously persisted height on mount', () => {
    localStorage.setItem(BOTTOM_SECTIONS_HEIGHT_KEY, '260');
    root = renderPanel(container, [makeHealthy()]);
    const bottom = container.querySelector('.bottom-sections') as HTMLElement;
    expect(bottom.style.height).toBe('260px');
    expect(bottom.classList.contains('bottom-sections-resized')).toBe(true);
  });

  test('double-click on the handle resets to the CSS default and clears the stored height', () => {
    localStorage.setItem(BOTTOM_SECTIONS_HEIGHT_KEY, '260');
    root = renderPanel(container, [makeHealthy()]);
    const resizer = container.querySelector('[data-testid="bottom-sections-resizer"]') as HTMLElement;
    const bottom = container.querySelector('.bottom-sections') as HTMLElement;
    expect(bottom.style.height).toBe('260px');

    act(() => {
      resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    // Reverts to the CSS default: no inline height, no resized marker class.
    expect(bottom.style.height).toBe('');
    expect(bottom.classList.contains('bottom-sections-resized')).toBe(false);
    expect(localStorage.getItem(BOTTOM_SECTIONS_HEIGHT_KEY)).toBeNull();
  });
});
