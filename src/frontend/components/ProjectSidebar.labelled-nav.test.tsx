// @vitest-environment happy-dom
/**
 * Labelled navigation (#3561 slice 5a, variant B "triage inbox").
 *
 * At 1280 px and wider the 52 px icon rail becomes a 212 px navigation:
 * queues with counts first, then projects by name with counts. Under 1280 px
 * the same DOM collapses back to today's icons via CSS, so these tests pin the
 * DOM contract (labels, counts, which rows are marked idle, which callbacks a
 * queue fires). The width switch itself is checked in Playwright.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectSidebar, type ProjectSidebarQueues } from './ProjectSidebar.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetProjectNotificationMuteForTests } from '../hooks/useProjectNotificationMute.js';
import type { ProjectSummary } from '../../shared/protocol.js';
import type { ScheduleResponse } from '../../shared/contracts/schedule.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function summary(project: string, displayName: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project,
    displayName,
    color: 1,
    activeAgents: 0,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openContributionAttempts: 0,
    recentTasks: [],
    tracked: true,
    ...extra,
  };
}

function seedProjects() {
  useKookrStore.getState().handleProjectSummaries([
    summary('github.com/org/live', 'org/live', { activeAgents: 2 }),
    summary('github.com/org/waiting', 'org/waiting', { findingCount: 3 }),
    summary('github.com/org/idle-a', 'org/idle-a'),
    summary('github.com/org/idle-b', 'org/idle-b', { localPath: '/home/me/src/idle-b' }),
  ]);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function queues(overrides: Partial<ProjectSidebarQueues> = {}): ProjectSidebarQueues {
  return {
    needsYou: 3,
    working: 5,
    finished: 7,
    onNeedsYou: vi.fn(),
    onWorking: vi.fn(),
    onFinished: vi.fn(),
    onScheduled: vi.fn(),
    ...overrides,
  };
}

describe('ProjectSidebar labelled navigation (#3561 slice 5a)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let localStore: Map<string, string>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStore = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => localStore.set(key, value),
      removeItem: (key: string) => localStore.delete(key),
      clear: () => localStore.clear(),
    });
    __resetProjectNotificationMuteForTests();
    syncGlobalStore();
    seedProjects();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    __resetProjectNotificationMuteForTests();
    vi.unstubAllGlobals();
  });

  async function render(q: ProjectSidebarQueues | null = queues()) {
    await act(async () => {
      root.render(<ProjectSidebar onManage={() => {}} queues={q ?? undefined} />);
    });
    await flush();
  }

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  test('each project row carries its name as a label, and the all-projects row says so', async () => {
    await render();
    const live = byTestId('project-icon-github.com/org/live');
    expect(live?.querySelector('.project-nav-name')?.textContent).toBe('org/live');
    expect(byTestId('project-icon-all')?.querySelector('.project-nav-name')?.textContent).toBe('All projects');
  });

  test('queues show their counts from the list buckets and fire their own action', async () => {
    const q = queues();
    await render(q);
    const needs = byTestId('nav-queue-needs-you');
    const working = byTestId('nav-queue-working');
    const finished = byTestId('nav-queue-finished');
    expect(needs?.textContent).toContain('Needs you');
    expect(needs?.querySelector('.project-nav-count')?.textContent).toBe('3');
    expect(working?.querySelector('.project-nav-count')?.textContent).toBe('5');
    expect(finished?.querySelector('.project-nav-count')?.textContent).toBe('7');

    await act(async () => { needs?.click(); });
    await act(async () => { working?.click(); });
    await act(async () => { finished?.click(); });
    expect(q.onNeedsYou).toHaveBeenCalledTimes(1);
    expect(q.onWorking).toHaveBeenCalledTimes(1);
    expect(q.onFinished).toHaveBeenCalledTimes(1);
  });

  test('the Needs you count is marked as waiting on you only when something waits', async () => {
    await render(queues({ needsYou: 2 }));
    expect(byTestId('nav-queue-needs-you')?.querySelector('.project-nav-count')?.classList.contains('need')).toBe(true);
    await render(queues({ needsYou: 0 }));
    expect(byTestId('nav-queue-needs-you')?.querySelector('.project-nav-count')?.classList.contains('need')).toBe(false);
  });

  test('Scheduled counts enabled schedules only and opens the schedules surface', async () => {
    const schedule = (id: string, enabled: boolean) => ({ id, enabled } as unknown as ScheduleResponse);
    useKookrStore.setState({ schedules: [schedule('a', true), schedule('b', false), schedule('c', true)] });
    const q = queues();
    await render(q);
    const scheduled = byTestId('nav-queue-scheduled');
    expect(scheduled?.querySelector('.project-nav-count')?.textContent).toBe('2');
    await act(async () => { scheduled?.click(); });
    expect(q.onScheduled).toHaveBeenCalledTimes(1);
  });

  test('no queue claims a selected state, because a queue jumps instead of filtering', async () => {
    await render();
    for (const id of ['nav-queue-needs-you', 'nav-queue-working', 'nav-queue-finished', 'nav-queue-scheduled']) {
      const el = byTestId(id);
      expect(el?.classList.contains('selected')).toBe(false);
      expect(el?.getAttribute('aria-current')).toBeNull();
    }
  });

  test('without queue props the rail renders no queue buttons', async () => {
    await render(null);
    expect(container.querySelector('[data-testid^="nav-queue-"]')).toBeNull();
    expect(byTestId('project-icon-github.com/org/live')).not.toBeNull();
  });

  test('projects with no live task and no finding are marked idle and tucked behind a toggle', async () => {
    await render();
    const idleA = byTestId('project-icon-github.com/org/idle-a');
    const idleB = byTestId('project-icon-github.com/org/idle-b');
    const live = byTestId('project-icon-github.com/org/live');
    const waiting = byTestId('project-icon-github.com/org/waiting');
    // Idle rows stay in the DOM: under 1280 px the icon rail shows every project.
    expect(idleA?.closest('.project-nav-idle')).not.toBeNull();
    expect(idleB?.closest('.project-nav-idle')).not.toBeNull();
    expect(live?.closest('.project-nav-idle')).toBeNull();
    expect(waiting?.closest('.project-nav-idle')).toBeNull();

    const toggle = byTestId('project-nav-idle-toggle');
    expect(toggle?.textContent).toBe('All 4 projects');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle?.click(); });
    expect(byTestId('project-icon-github.com/org/idle-a')?.closest('.project-nav-idle')).toBeNull();
    expect(byTestId('project-nav-idle-toggle')?.textContent).toBe('Hide idle projects');
    expect(byTestId('project-nav-idle-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  test('a pinned or selected idle project stays listed', async () => {
    useKookrStore.getState().pinProjectToTop('github.com/org/idle-a');
    useKookrStore.getState().selectProject('github.com/org/idle-b');
    await render();
    expect(byTestId('project-icon-github.com/org/idle-a')?.closest('.project-nav-idle')).toBeNull();
    expect(byTestId('project-icon-github.com/org/idle-b')?.closest('.project-nav-idle')).toBeNull();
  });

  test('a filter query lists idle matches without the toggle', async () => {
    await render();
    const input = byTestId('project-sidebar-filter') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'idle-b');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const idleB = byTestId('project-icon-github.com/org/idle-b');
    expect(idleB).not.toBeNull();
    expect(idleB?.closest('.project-nav-idle')).toBeNull();
    expect(byTestId('project-icon-github.com/org/live')).toBeNull();
  });

  test('the labelled layout can be switched off, leaving the icon rail', async () => {
    await render();
    expect(byTestId('project-sidebar')?.classList.contains('labelled')).toBe(true);
    await act(async () => {
      root.render(<ProjectSidebar onManage={() => {}} queues={queues()} labelled={false} />);
    });
    expect(byTestId('project-sidebar')?.classList.contains('labelled')).toBe(false);
  });

  test('the toggle is absent when every project is live', async () => {
    useKookrStore.getState().handleProjectSummaries([
      summary('github.com/org/live', 'org/live', { activeAgents: 1 }),
    ]);
    await render();
    expect(byTestId('project-nav-idle-toggle')).toBeNull();
  });
});
