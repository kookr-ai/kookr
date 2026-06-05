// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DebugTimelinePanel } from './DebugTimelinePanel.js';
import {
  clearDebugTimeline,
  recordStoreMutationDebugEvent,
  recordWebSocketDebugEvent,
  setDebugTimelineEnabledForTests,
} from '../debug-timeline.js';

describe('DebugTimelinePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setDebugTimelineEnabledForTests(true);
    clearDebugTimeline();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setDebugTimelineEnabledForTests(null);
    clearDebugTimeline();
  });

  test('renders captured entries and filters the timeline', () => {
    recordWebSocketDebugEvent('inbound', '{"type":"snapshot"}', { type: 'snapshot' });
    recordStoreMutationDebugEvent([], [], ['connected'], { connected: true });

    act(() => {
      root.render(React.createElement(DebugTimelinePanel, { onExport: vi.fn() }));
    });

    expect(container.textContent).toContain('inbound snapshot');
    expect(container.textContent).toContain('store mutation: connected');

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Debug timeline kind"]')!;
    act(() => {
      select.value = 'websocket';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain('inbound snapshot');
    expect(container.textContent).not.toContain('store mutation: connected');
  });

  test('invokes export action', () => {
    const onExport = vi.fn();
    act(() => {
      root.render(React.createElement(DebugTimelinePanel, { onExport }));
    });

    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Export trace')!;
    act(() => {
      button.click();
    });

    expect(onExport).toHaveBeenCalledTimes(1);
  });
});
