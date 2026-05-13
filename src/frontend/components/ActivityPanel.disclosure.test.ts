// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentActivityMeta, AgentEvent } from '../../shared/protocol.js';
import { ActivityPanel } from './ActivityPanel.js';

function meta(overrides: Partial<AgentActivityMeta> = {}): AgentActivityMeta {
  return {
    totalEventsSeen: 0,
    parentEventCount: 0,
    childEventCount: 0,
    foreignEventCount: 0,
    unknownParentageCount: 0,
    malformedRecordCount: 0,
    droppedRecordCount: 0,
    duplicateRecordCount: 0,
    ...overrides,
  };
}

function render(
  container: HTMLElement,
  props: { events: AgentEvent[]; activityMeta?: AgentActivityMeta; taskId?: string },
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ActivityPanel, props));
  });
  return root;
}

const userEvent: AgentEvent = { type: 'user_prompt', sessionId: 's1', prompt: 'Fix bug' };

describe('ActivityPanel disclosure banner (rfc-activity-log-reliability §4)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  test('does not render banner when activityMeta is omitted', () => {
    root = render(container, { events: [userEvent] });
    expect(container.querySelector('[data-testid="act-disclosure-banner"]')).toBeNull();
  });

  test('shows "Showing last N of M events" when monitor window is capped', () => {
    root = render(container, {
      events: [userEvent],
      activityMeta: meta({ totalEventsSeen: 75, parentEventCount: 75 }),
    });
    const partial = container.querySelector('.act-disclosure-partial');
    expect(partial).not.toBeNull();
    expect(partial!.textContent).toContain('Showing last 1 of 75 events');
  });

  test('shows child-activity count when child events exist', () => {
    root = render(container, {
      events: [userEvent],
      activityMeta: meta({ totalEventsSeen: 1, parentEventCount: 1, childEventCount: 12 }),
    });
    const child = container.querySelector('.act-disclosure-child');
    expect(child).not.toBeNull();
    expect(child!.textContent).toContain('Child agent activity: 12 events not shown');
  });

  test('shows malformed warning with diagnostics link when taskId is provided', () => {
    root = render(container, {
      events: [userEvent],
      activityMeta: meta({ totalEventsSeen: 3, malformedRecordCount: 2, droppedRecordCount: 1 }),
      taskId: 'task-42',
    });
    const m = container.querySelector('.act-disclosure-malformed');
    expect(m).not.toBeNull();
    expect(m!.textContent).toContain('2 hook records malformed');
    expect(m!.textContent).toContain('1 dropped');
    const link = m!.querySelector('a.act-disclosure-link') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/api/tasks/task-42/activity-diagnostics');
  });

  test('renders disclosure even on empty event list when only malformed records exist', () => {
    root = render(container, {
      events: [],
      activityMeta: meta({ malformedRecordCount: 1, totalEventsSeen: 1 }),
    });
    expect(container.querySelector('[data-testid="act-disclosure-banner"]')).not.toBeNull();
    expect(container.querySelector('.act-disclosure-malformed')).not.toBeNull();
    expect(container.querySelector('.act-empty')).not.toBeNull();
  });

  test('omits banner when meta values match what is shown and nothing is wrong', () => {
    root = render(container, {
      events: [userEvent],
      activityMeta: meta({ totalEventsSeen: 1, parentEventCount: 1 }),
    });
    expect(container.querySelector('[data-testid="act-disclosure-banner"]')).toBeNull();
  });
});
