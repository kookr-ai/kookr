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

  test('keyboard ArrowUp grows the sections and persists the height', () => {
    root = renderPanel(container, [makeHealthy()]);
    const resizer = container.querySelector('[data-testid="bottom-sections-resizer"]') as HTMLElement;

    act(() => {
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });

    const bottom = container.querySelector('.bottom-sections') as HTMLElement;
    // An explicit inline height now overrides the default max-height cap.
    expect(bottom.classList.contains('bottom-sections-resized')).toBe(true);
    expect(bottom.style.height).toMatch(/px$/);
    expect(bottom.style.maxHeight).toBe('none');

    // The chosen height is persisted (clamped to at least the minimum).
    const stored = Number(localStorage.getItem(BOTTOM_SECTIONS_HEIGHT_KEY));
    expect(stored).toBeGreaterThanOrEqual(MIN_BOTTOM_SECTIONS_HEIGHT);
  });

  test('applies a previously persisted height on mount', () => {
    localStorage.setItem(BOTTOM_SECTIONS_HEIGHT_KEY, '260');
    root = renderPanel(container, [makeHealthy()]);
    const bottom = container.querySelector('.bottom-sections') as HTMLElement;
    expect(bottom.style.height).toBe('260px');
    expect(bottom.classList.contains('bottom-sections-resized')).toBe(true);
  });
});
