// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProjectSummary } from '../../shared/protocol.js';
import { ProjectDetailDrawer } from './ProjectDetailDrawer.js';

function baseProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project: 'github.com/octo/cat',
    displayName: 'octo/cat',
    color: 0,
    activeAgents: 1,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openContributionAttempts: 0,
    recentTasks: [],
    tracked: false,
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderDrawer(project: ProjectSummary) {
  act(() => {
    root.render(
      React.createElement(ProjectDetailDrawer, {
        project,
        onClose: () => {},
        send: () => true,
      }),
    );
  });
}

describe('ProjectDetailDrawer — last shipped recency', () => {
  test('renders a relative "Last shipped" hint when lastContribution is present', () => {
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    renderDrawer(baseProject({ lastContribution: iso }));

    expect(container.textContent).toContain('Last shipped');
    const value = container.querySelector('[data-testid="last-shipped-value"]');
    expect(value).not.toBeNull();
    expect(value?.textContent).toBe('3d ago');
  });

  test('exposes the absolute date on hover', () => {
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    renderDrawer(baseProject({ lastContribution: iso }));

    const value = container.querySelector('[data-testid="last-shipped-value"]');
    expect(value?.getAttribute('title')).toBe(new Date(iso).toLocaleString());
  });

  test('omits the hint entirely when lastContribution is undefined', () => {
    renderDrawer(baseProject({ lastContribution: undefined }));

    expect(container.querySelector('[data-testid="last-shipped-value"]')).toBeNull();
    expect(container.textContent).not.toContain('Last shipped');
  });

  test('omits the hint (rather than leaking "Invalid Date") for an unparseable value', () => {
    // relativeAgo returns '' for a date it cannot parse, so the guard must drop
    // the whole row instead of rendering an empty relative time with an
    // "Invalid Date" tooltip.
    renderDrawer(baseProject({ lastContribution: 'not-a-date' }));

    expect(container.querySelector('[data-testid="last-shipped-value"]')).toBeNull();
    expect(container.textContent).not.toContain('Last shipped');
    expect(container.textContent).not.toContain('Invalid Date');
  });
});

describe('ProjectDetailDrawer — stalled agents', () => {
  test('shows the stalled count when stalledAgents > 0', () => {
    renderDrawer(baseProject({ activeAgents: 5, stalledAgents: 2 }));

    expect(container.textContent).toContain('Stalled agents');
    const value = container.querySelector('[data-testid="stalled-agents-value"]');
    expect(value).not.toBeNull();
    expect(value?.textContent).toBe('2');
  });

  test('omits the stalled row when stalledAgents is 0', () => {
    renderDrawer(baseProject({ activeAgents: 5, stalledAgents: 0 }));

    expect(container.querySelector('[data-testid="stalled-agents-value"]')).toBeNull();
    expect(container.textContent).not.toContain('Stalled agents');
  });

  test('omits the stalled row when stalledAgents is undefined', () => {
    renderDrawer(baseProject({ activeAgents: 5, stalledAgents: undefined }));

    expect(container.querySelector('[data-testid="stalled-agents-value"]')).toBeNull();
    expect(container.textContent).not.toContain('Stalled agents');
  });
});
