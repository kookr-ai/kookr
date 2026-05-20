// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ScheduleSection, SCHEDULE_SECTION_COLLAPSED_KEY } from './ScheduleSection.js';
import type { ScheduleResponse } from '../../shared/protocol.js';

function makeSchedule(overrides: Partial<ScheduleResponse> = {}): ScheduleResponse {
  return {
    id: overrides.id ?? 'sched-1',
    name: overrides.name ?? 'Nightly sweep',
    enabled: overrides.enabled ?? true,
    cron: '0 3 * * *',
    playbook: { path: '/p.md', parameters: {} },
    cwd: '/repo',
    agentType: 'claude-code',
    executionLedger: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    nextRunAt: '2026-01-02T03:00:00Z',
    cronDescription: 'every day at 3:00',
    ...overrides,
  };
}

function render(container: HTMLElement, schedules: ScheduleResponse[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ScheduleSection, { schedules }));
  });
  return root;
}

describe('ScheduleSection collapsed-state persistence', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    root = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => { r.unmount(); });
    }
    document.body.innerHTML = '';
  });

  test('restores collapsed state from localStorage on mount', () => {
    localStorage.setItem(SCHEDULE_SECTION_COLLAPSED_KEY, '1');
    root = render(container, [makeSchedule()]);

    expect(container.querySelectorAll('.schedule-row').length).toBe(0);
    expect(container.querySelector('.section-chevron')?.textContent).toBe('▸');
  });

  test('renders collapsed by default when no preference is stored', () => {
    root = render(container, [makeSchedule()]);

    expect(container.querySelectorAll('.schedule-row').length).toBe(0);
    expect(container.querySelector('.section-chevron')?.textContent).toBe('▸');
  });

  test('renders expanded when stored value is "0"', () => {
    localStorage.setItem(SCHEDULE_SECTION_COLLAPSED_KEY, '0');
    root = render(container, [makeSchedule()]);

    expect(container.querySelectorAll('.schedule-row').length).toBe(1);
    expect(container.querySelector('.section-chevron')?.textContent).toBe('▾');
  });

  test('uses default (collapsed) when stored value is malformed', () => {
    localStorage.setItem(SCHEDULE_SECTION_COLLAPSED_KEY, 'true');
    root = render(container, [makeSchedule()]);

    expect(container.querySelectorAll('.schedule-row').length).toBe(0);
  });

  test('persists collapsed state when the header is clicked', () => {
    // Default is collapsed; click expands and writes "0", click again collapses and writes "1".
    root = render(container, [makeSchedule()]);

    const header = container.querySelector('.section-header') as HTMLElement;
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(localStorage.getItem(SCHEDULE_SECTION_COLLAPSED_KEY)).toBe('0');
    expect(container.querySelectorAll('.schedule-row').length).toBe(1);

    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(localStorage.getItem(SCHEDULE_SECTION_COLLAPSED_KEY)).toBe('1');
    expect(container.querySelectorAll('.schedule-row').length).toBe(0);
  });
});
