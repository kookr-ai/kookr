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
    localStorage.clear();
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
    // a11y: malformed row is announced to AT as a status message, carries a
    // visually-hidden severity prefix, and a non-color cue (warning glyph).
    expect(m!.getAttribute('role')).toBe('status');
    expect(m!.getAttribute('aria-live')).toBe('polite');
    expect(m!.querySelector('.sr-only')?.textContent).toBe('Warning: ');
    expect(m!.querySelector('.act-disclosure-icon')?.getAttribute('aria-hidden')).toBe('true');
    const link = m!.querySelector('a.act-disclosure-link') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/api/tasks/task-42/activity-diagnostics');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link!.getAttribute('aria-label')).toContain('new tab');
  });

  test('omits the diagnostics link when taskId is missing but still renders the warning', () => {
    root = render(container, {
      events: [userEvent],
      activityMeta: meta({ totalEventsSeen: 3, malformedRecordCount: 2 }),
      // no taskId
    });
    const m = container.querySelector('.act-disclosure-malformed');
    expect(m).not.toBeNull();
    expect(m!.textContent).toContain('2 hook records malformed');
    expect(m!.querySelector('a.act-disclosure-link')).toBeNull();
  });

  test('renders foreign-session activity inline with the child count', () => {
    root = render(container, {
      events: [userEvent],
      activityMeta: meta({ totalEventsSeen: 5, parentEventCount: 1, childEventCount: 2, foreignEventCount: 2 }),
    });
    const child = container.querySelector('.act-disclosure-child');
    expect(child).not.toBeNull();
    expect(child!.textContent).toContain('2 events');
    expect(child!.textContent).toContain('+2 foreign');
  });

  test('renders disclosure on the empty-state branch when only malformed records exist', () => {
    // Carefully pin totalEventsSeen=0 so the partialWindow branch does NOT fire
    // and the test isolates the malformed-only render path.
    root = render(container, {
      events: [],
      activityMeta: meta({ malformedRecordCount: 1, totalEventsSeen: 0 }),
    });
    expect(container.querySelector('[data-testid="act-disclosure-banner"]')).not.toBeNull();
    expect(container.querySelector('.act-disclosure-malformed')).not.toBeNull();
    expect(container.querySelector('.act-disclosure-partial')).toBeNull();
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
