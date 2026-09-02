// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, Playbook, ScheduleResponse } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { open as openOnboardingTour } from '../store/onboarding-store.js';
import { getTask } from '../api/tasks.js';
import {
  GETTING_STARTED_GUIDE_URL,
  OVERVIEW_PINNED_PLAYBOOK_LIMIT,
  OVERVIEW_RECENT_COMPLETED_LIMIT,
  OVERVIEW_RECENT_PLAYBOOK_LIMIT,
  OVERVIEW_RUNNING_LIMIT,
  OverviewEmptyState,
} from './OverviewEmptyState.js';
import { NARRATED_DEMO_YOUTUBE_URL } from './OnboardingTour.js';

vi.mock('../store/onboarding-store.js', () => ({
  open: vi.fn(),
}));

vi.mock('../api/tasks.js', () => ({
  getTask: vi.fn(),
}));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeWaitingAgent(agentId: string, taskName: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName,
    events: [],
    anomaly: {
      agentId,
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting on you',
      detectedAt: new Date(),
    },
    cwd: '/home/user/projects/demo',
    taskStatus: 'inProgress',
    ...overrides,
  };
}

function makeRunningAgent(agentId: string, taskName: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName,
    events: [],
    anomaly: null,
    cwd: '/tmp/projects/demo',
    taskStatus: 'inProgress',
    startedAt: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

function makeCompletedAgent(agentId: string, taskName: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName,
    events: [],
    anomaly: null,
    cwd: '/tmp/kookr',
    taskStatus: 'completed',
    finishedAt: '2026-06-20T10:00:00.000Z',
    agentType: 'claude-code',
    ...overrides,
  };
}

function seedRecentPlaybooks(keys: string[]): void {
  localStorage.setItem('kookr:recentPlaybooks', JSON.stringify(keys));
}

function seedPinnedPlaybooks(keys: string[]): void {
  localStorage.setItem('kookr:pinnedPlaybooks', JSON.stringify(keys));
}

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
    nextRunAt: '2026-06-20T10:12:00.000Z',
    cronDescription: 'every day at 3:00',
    ...overrides,
  };
}

function samplePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'deploy.md',
    name: 'Deploy to prod',
    description: 'Ship it',
    parameters: [],
    checklist: [],
    tags: [],
    body: 'Deploy.',
    sourceCwd: '/project',
    scope: 'project',
    ...overrides,
  };
}

describe('OverviewEmptyState', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.mocked(openOnboardingTour).mockClear();
    vi.mocked(getTask).mockReset();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function render(props: Partial<React.ComponentProps<typeof OverviewEmptyState>> = {}) {
    act(() => {
      root.render(React.createElement(OverviewEmptyState, {
        waiting: [],
        running: [],
        completed: [],
        onLaunch: vi.fn(),
        ...props,
      }));
    });
  }

  test('renders aggregate counts for running / needs input / completed', () => {
    render({
      waiting: [makeWaitingAgent('agent-1', 'Fix the build')],
      running: [
        makeRunningAgent('run-1', 'Watch logs'),
        makeRunningAgent('run-2', 'Ship the dashboard'),
        makeRunningAgent('run-3', 'Keep the worker warm'),
      ],
      completed: [
        makeCompletedAgent('done-1', 'Ship the fix'),
        makeCompletedAgent('done-2', 'Tidy the changelog'),
      ],
    });

    const counts = Array.from(container.querySelectorAll('.overview-count')).map((el) => ({
      value: el.querySelector('.overview-count-value')?.textContent,
      label: el.querySelector('.overview-count-label')?.textContent,
    }));
    expect(counts).toEqual([
      { value: '3', label: 'running' },
      { value: '1', label: 'needs input' },
      { value: '2', label: 'completed' },
    ]);
  });

  test('lists waiting tasks and clicking a row selects that agent', () => {
    const waiting = [
      makeWaitingAgent('agent-1', 'Fix the build'),
      makeWaitingAgent('agent-2', 'Review the diff'),
    ];
    useKookrStore.setState({ agents: waiting });
    render({ waiting });

    expect(container.textContent).toContain('Waiting on you');
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.overview-waiting-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Fix the build');
    expect(rows[1].textContent).toContain('Review the diff');

    act(() => {
      rows[1].click();
    });
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
  });

  test('shows signal wait age from pendingSignal when anomaly was re-stamped', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T18:57:00Z'));
    const waiting = [
      makeWaitingAgent('agent-1', 'Review the completed task', {
        anomaly: {
          agentId: 'agent-1',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'waiting on you',
          detectedAt: new Date('2026-06-11T18:49:00Z'),
        },
        pendingSignal: {
          kind: 'completion_ready',
          raisedAt: '2026-06-07T22:47:00Z',
        },
        turnState: 'completed_turn',
      }),
    ];

    render({ waiting });

    expect(container.querySelector('.overview-waiting-row')?.textContent).toContain('waiting 3d');
  });

  test('shows the no-agents message when there is nothing at all', () => {
    render();

    expect(container.textContent).toContain('No agents running.');
    expect(container.querySelector('.overview-waiting')).toBeNull();
    expect(container.querySelector('[data-testid="overview-running"]')).toBeNull();
    expect(container.textContent).not.toContain('Running');
  });

  test('shows the all-clear message when agents run but none need input', () => {
    render({
      running: [
        makeRunningAgent('run-1', 'Watch logs'),
        makeRunningAgent('run-2', 'Ship the dashboard'),
      ],
    });

    expect(container.textContent).toContain('All clear — agents working autonomously.');
  });

  test('lists running tasks and clicking a row selects that agent', () => {
    const running = [
      makeRunningAgent('run-1', 'Watch logs'),
      makeRunningAgent('run-2', 'Ship the dashboard'),
    ];
    useKookrStore.setState({ agents: running });
    render({ running });

    const section = container.querySelector('[data-testid="overview-running"]');
    expect(section).not.toBeNull();
    expect(container.textContent).toContain('Running');
    const rows = Array.from(section?.querySelectorAll<HTMLButtonElement>('.overview-waiting-row') ?? []);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Watch logs');
    expect(rows[0].textContent).toContain('demo');
    expect(rows[1].textContent).toContain('Ship the dashboard');
    expect(section?.textContent).not.toContain('Relaunch');

    act(() => {
      rows[1].click();
    });
    expect(useKookrStore.getState().selectedAgentId).toBe('run-2');
    expect(useKookrStore.getState().selectedTaskId).toBe('task-run-2');
  });

  test('hides the Running block when no healthy agents are live', () => {
    render({ waiting: [makeWaitingAgent('agent-1', 'Fix the build')] });

    expect(container.querySelector('[data-testid="overview-running"]')).toBeNull();
    expect(container.textContent).toContain('Waiting on you');
    expect(container.textContent).toContain('Fix the build');
    expect(container.querySelectorAll('.overview-waiting-row')).toHaveLength(1);
  });

  test('caps the Running list at six and points overflow at the healthy rail', () => {
    render({
      running: Array.from({ length: OVERVIEW_RUNNING_LIMIT + 2 }, (_, i) =>
        makeRunningAgent(`run-${i}`, `Live task ${i}`),
      ),
    });

    const section = container.querySelector('[data-testid="overview-running"]');
    expect(section?.querySelectorAll('.overview-waiting-row')).toHaveLength(OVERVIEW_RUNNING_LIMIT);
    expect(container.textContent).toContain('Live task 0');
    expect(container.textContent).toContain(`Live task ${OVERVIEW_RUNNING_LIMIT - 1}`);
    expect(container.textContent).not.toContain(`Live task ${OVERVIEW_RUNNING_LIMIT}`);
    expect(container.textContent).toContain('+2 more in Healthy');
    expect(section?.textContent).not.toContain('Relaunch');
  });

  test('does not show an overflow line when exactly six running tasks exist', () => {
    render({
      running: Array.from({ length: OVERVIEW_RUNNING_LIMIT }, (_, i) =>
        makeRunningAgent(`run-${i}`, `Live task ${i}`),
      ),
    });

    const section = container.querySelector('[data-testid="overview-running"]');
    expect(section?.querySelectorAll('.overview-waiting-row')).toHaveLength(OVERVIEW_RUNNING_LIMIT);
    expect(container.textContent).not.toContain('more in Healthy');
  });

  test('omits the running duration when startedAt is missing', () => {
    render({
      running: [makeRunningAgent('run-1', 'Watch logs', { startedAt: undefined })],
    });

    const row = container.querySelector('[data-testid="overview-running"] .overview-waiting-row');
    expect(row?.textContent).toContain('Watch logs');
    expect(row?.textContent).toContain('demo');
    expect(row?.textContent).not.toMatch(/running /);
  });

  test('shows how long a running task has been live', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T10:12:00.000Z'));
    render({
      running: [makeRunningAgent('run-1', 'Watch logs', { startedAt: '2026-06-20T10:00:00.000Z' })],
    });

    expect(container.querySelector('[data-testid="overview-running"]')?.textContent).toContain('running 12m');
  });

  test('leaves the waiting list and first-run links alone when both waiting and running exist', () => {
    const waiting = [makeWaitingAgent('agent-1', 'Fix the build')];
    const running = [makeRunningAgent('run-1', 'Watch logs')];
    render({ waiting, running });

    expect(container.textContent).toContain('Waiting on you');
    expect(container.textContent).toContain('Fix the build');
    expect(container.textContent).toContain('Watch logs');
    expect(container.querySelector('.overview-tour-reentry')).toBeNull();
    expect(container.textContent).not.toContain('Getting Started');
    expect(container.textContent).not.toContain('Check setup');
  });

  test('first-run empty state shows a Take the tour affordance that reopens the tour', () => {
    render();

    const tourLink = Array.from(container.querySelectorAll<HTMLButtonElement>('button.overview-tour-link'))
      .find((el) => el.textContent?.includes('Take the tour'));
    expect(tourLink).toBeDefined();
    expect(container.querySelector('.overview-tour-reentry')?.textContent).toContain('New to Kookr?');

    act(() => {
      tourLink?.click();
    });
    expect(openOnboardingTour).toHaveBeenCalledTimes(1);
  });

  test('first-run empty state shows Getting Started and Check setup next to Take the tour', () => {
    const onCheckSetup = vi.fn();
    render({ onCheckSetup });

    const gettingStarted = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a.overview-tour-link'),
    ).find((el) => el.textContent?.includes('Getting Started'));
    expect(gettingStarted).toBeDefined();
    expect(gettingStarted?.textContent).toContain('Getting Started');
    expect(GETTING_STARTED_GUIDE_URL).toBe(
      'https://github.com/kookr-ai/kookr/blob/main/docs/getting-started.md',
    );
    expect(gettingStarted?.href).toBe(GETTING_STARTED_GUIDE_URL);
    expect(gettingStarted?.target).toBe('_blank');
    expect(gettingStarted?.rel).toBe('noopener noreferrer');

    const checkSetup = Array.from(container.querySelectorAll<HTMLButtonElement>('button.overview-tour-link'))
      .find((el) => el.textContent?.includes('Check setup'));
    expect(checkSetup).toBeDefined();
    expect(container.textContent).toContain('pnpm run doctor');

    act(() => {
      checkSetup?.click();
    });
    expect(onCheckSetup).toHaveBeenCalledTimes(1);
  });

  test('first-run empty state links the narrated demo, reusing the shared URL constant', () => {
    render();

    const demoLink = container.querySelector<HTMLAnchorElement>(
      'a[data-testid="overview-demo-link"]',
    );
    expect(demoLink).not.toBeNull();
    expect(demoLink?.textContent).toContain('Watch the 2-minute demo');
    // Reuse the exported constant rather than a fresh hard-coded URL: pin the
    // constant's value AND the rendered href, so a wrong/empty constant is caught.
    expect(NARRATED_DEMO_YOUTUBE_URL).toBe('https://youtu.be/DHZrO8T_6Xg');
    expect(demoLink?.href).toBe(NARRATED_DEMO_YOUTUBE_URL);
    expect(demoLink?.target).toBe('_blank');
    expect(demoLink?.rel).toBe('noopener noreferrer');
    // The demo link lives inside the first-run "New to Kookr?" row.
    const reentryRow = container.querySelector('.overview-tour-reentry');
    expect(reentryRow?.contains(demoLink)).toBe(true);
  });

  test('does not link the narrated demo once any task exists', () => {
    render({ waiting: [makeWaitingAgent('agent-1', 'Fix the build')] });

    expect(
      container.querySelector('a[data-testid="overview-demo-link"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Watch the 2-minute demo');
  });

  test('does not show the first-run setup links in the returning-empty all-clear branch', () => {
    render({
      running: [
        makeRunningAgent('run-1', 'Watch logs'),
        makeRunningAgent('run-2', 'Ship the dashboard'),
      ],
    });

    expect(container.textContent).toContain('All clear — agents working autonomously.');
    expect(container.querySelector('.overview-tour-reentry')).toBeNull();
    expect(container.querySelector('.overview-tour-link')).toBeNull();
    expect(container.textContent).not.toContain('Getting Started');
    expect(container.textContent).not.toContain('Check setup');
    expect(container.textContent).not.toContain('pnpm run doctor');
  });

  test('does not show the first-run setup links when only completed agents remain', () => {
    render({ completed: [makeCompletedAgent('done-1', 'Ship the fix')] });

    expect(container.textContent).toContain('All clear — agents working autonomously.');
    expect(container.querySelector('.overview-tour-link')).toBeNull();
    expect(container.textContent).not.toContain('Getting Started');
    expect(container.textContent).not.toContain('Check setup');
  });

  test('keyboard hint includes the command palette and quick launch shortcuts', () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    render();

    const hint = container.querySelector('.detail-empty-hint');
    expect(hint?.textContent).toContain('palette');
    expect(hint?.textContent).toContain('quick launch');
    const keys = Array.from(hint?.querySelectorAll('kbd') ?? []).map((el) => el.textContent);
    expect(keys).toContain('Ctrl');
    expect(keys).toContain('K');
    expect(keys).not.toContain('⌘K');

    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    render();
    const macHint = container.querySelector('.detail-empty-hint');
    const macKeys = Array.from(macHint?.querySelectorAll('kbd') ?? []).map((el) => el.textContent);
    // Palette chord is the single-glyph ⌘K (not Ctrl+K); other bindings may still use Ctrl.
    expect(macKeys[0]).toBe('⌘K');
    expect(macHint?.textContent).toMatch(/⌘K.*palette/);

    Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
  });

  test('voice hint only appears when speech-to-text is configured', () => {
    render();
    expect(container.querySelector('.detail-empty-hint')?.textContent).not.toContain('voice');

    useKookrStore.setState({ sttUrl: 'http://localhost:9000/stt' });
    render();
    expect(container.querySelector('.detail-empty-hint')?.textContent).toContain('voice');
  });

  test('keeps first-run setup links when recents exist and no task has been created', () => {
    seedRecentPlaybooks(['/project::deploy.md']);
    render();

    expect(container.querySelector('[data-testid="overview-recent-playbooks"]')).not.toBeNull();
    expect(container.querySelector('.overview-tour-reentry')?.textContent).toContain('New to Kookr?');
    expect(container.textContent).toContain('Take the tour');
    expect(container.textContent).toContain('Getting Started');
    expect(container.textContent).toContain('Check setup');
  });

  test('does not show a recents heading when PlaybookUsageTracker is empty', () => {
    render();

    expect(container.querySelector('[data-testid="overview-recent-playbooks"]')).toBeNull();
    expect(container.textContent).not.toContain('Recent playbooks');
    expect(container.querySelector('[data-testid="overview-pinned-playbooks"]')).toBeNull();
    expect(container.textContent).not.toContain('Pinned playbooks');
  });

  test('shows pinned playbook chips when only pins exist', () => {
    seedPinnedPlaybooks(['/project::deploy.md', '/project::review.md']);
    useKookrStore.setState({ playbooks: [samplePlaybook()] });
    const onLaunchPlaybooks = vi.fn();
    render({ onLaunchPlaybooks });

    expect(container.querySelector('[data-testid="overview-recent-playbooks"]')).toBeNull();
    expect(container.textContent).not.toContain('Recent playbooks');
    expect(container.textContent).toContain('Pinned playbooks');
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-pinned-playbook"]'));
    expect(chips.map((chip) => chip.textContent)).toEqual(['Deploy to prod', 'review']);

    act(() => {
      chips[0].click();
    });
    expect(onLaunchPlaybooks).toHaveBeenCalledTimes(1);
  });

  test('shows up to three pinned playbooks and hides overflow', () => {
    seedPinnedPlaybooks([
      '/project::one.md',
      '/project::two.md',
      '/project::three.md',
      '/project::four.md',
    ]);
    render();

    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-pinned-playbook"]'));
    expect(chips).toHaveLength(OVERVIEW_PINNED_PLAYBOOK_LIMIT);
    expect(chips.map((chip) => chip.textContent)).toEqual(['one', 'two', 'three']);
    expect(container.textContent).not.toContain('four');
  });

  test('lists an overlapping playbook only under Pinned, not Recents', () => {
    seedPinnedPlaybooks(['/project::deploy.md', '/other::sweep.md']);
    seedRecentPlaybooks(['/project::deploy.md', '/project::review.md']);
    useKookrStore.setState({ playbooks: [samplePlaybook()] });
    render();

    const pinned = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-pinned-playbook"]'));
    const recents = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-recent-playbook"]'));
    expect(pinned.map((chip) => chip.textContent)).toEqual(['Deploy to prod', 'sweep']);
    expect(recents.map((chip) => chip.textContent)).toEqual(['review']);
    expect(recents.map((chip) => chip.dataset.playbookKey)).not.toContain('/project::deploy.md');
  });

  test('hides the recents heading when every recent playbook is also pinned', () => {
    seedPinnedPlaybooks(['/project::deploy.md']);
    seedRecentPlaybooks(['/project::deploy.md']);
    render();

    expect(container.querySelector('[data-testid="overview-pinned-playbooks"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="overview-recent-playbooks"]')).toBeNull();
    expect(container.textContent).toContain('Pinned playbooks');
    expect(container.textContent).not.toContain('Recent playbooks');
  });

  test('does not list a playbook twice when pin is a legacy bare id and recent is composite', () => {
    seedPinnedPlaybooks(['deploy.md']);
    seedRecentPlaybooks(['/project::deploy.md', '/project::review.md']);
    useKookrStore.setState({ playbooks: [samplePlaybook()] });
    render();

    const pinned = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-pinned-playbook"]'));
    const recents = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-recent-playbook"]'));
    expect(pinned.map((chip) => chip.textContent)).toEqual(['Deploy to prod']);
    expect(recents.map((chip) => chip.textContent)).toEqual(['review']);
    expect(recents.map((chip) => chip.dataset.playbookKey)).not.toContain('/project::deploy.md');
  });

  test('keeps an overflow pin out of recents while still showing a non-pinned recent', () => {
    seedPinnedPlaybooks([
      '/project::one.md',
      '/project::two.md',
      '/project::three.md',
      '/project::four.md',
    ]);
    seedRecentPlaybooks(['/project::four.md', '/project::review.md']);
    render();

    const pinned = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-pinned-playbook"]'));
    const recents = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-recent-playbook"]'));
    expect(pinned.map((chip) => chip.textContent)).toEqual(['one', 'two', 'three']);
    expect(recents.map((chip) => chip.textContent)).toEqual(['review']);
    expect(recents.map((chip) => chip.dataset.playbookKey)).not.toContain('/project::four.md');
    expect(container.textContent).not.toContain('four');
  });

  test('re-reads recents after a same-tab launch updates localStorage', () => {
    seedRecentPlaybooks(['/project::old.md']);
    render({ running: [makeRunningAgent('run-1', 'Watch logs')] });
    expect(container.querySelector('[data-testid="overview-recent-playbook"]')?.textContent).toBe('old');

    seedRecentPlaybooks(['/project::new.md', '/project::old.md']);
    render({
      running: [
        makeRunningAgent('run-1', 'Watch logs'),
        makeRunningAgent('run-2', 'Ship the dashboard'),
      ],
    });
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-recent-playbook"]'));
    expect(chips.map((chip) => chip.textContent)).toEqual(['new', 'old']);
  });

  test('shows up to three recent playbooks and calls onLaunchPlaybooks', () => {
    seedRecentPlaybooks([
      '/project::deploy.md',
      '/project::review.md',
      '/other::sweep.md',
      '/other::extra.md',
    ]);
    useKookrStore.setState({ playbooks: [samplePlaybook()] });
    const onLaunchPlaybooks = vi.fn();
    render({ onLaunchPlaybooks });

    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="overview-recent-playbook"]'));
    expect(container.textContent).toContain('Recent playbooks');
    expect(chips).toHaveLength(OVERVIEW_RECENT_PLAYBOOK_LIMIT);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Deploy to prod',
      'review',
      'sweep',
    ]);
    expect(chips[0].dataset.playbookKey).toBe('/project::deploy.md');

    act(() => {
      chips[1].click();
    });
    expect(onLaunchPlaybooks).toHaveBeenCalledTimes(1);
  });

  test('recent playbooks stay visible after tasks exist and leave first-run links alone', () => {
    seedRecentPlaybooks(['legacy-bare.md']);
    render({
      running: [
        makeRunningAgent('run-1', 'Watch logs'),
        makeRunningAgent('run-2', 'Ship the dashboard'),
      ],
    });

    expect(container.textContent).toContain('All clear — agents working autonomously.');
    expect(container.querySelector('[data-testid="overview-recent-playbooks"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="overview-recent-playbook"]')?.textContent).toBe('legacy-bare');
    expect(container.querySelector('.overview-tour-reentry')).toBeNull();
    expect(container.textContent).not.toContain('Getting Started');
  });

  test('shows the soonest enabled schedule name and a relative next-fire time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'));
    useKookrStore.setState({
      schedules: [makeSchedule({ name: 'Nightly sweep', nextRunAt: '2026-06-20T10:12:00.000Z' })],
    });
    render();

    const section = container.querySelector('[data-testid="overview-next-schedule"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Nightly sweep');
    expect(section?.textContent).toContain('in 12m');
    expect(section?.textContent).not.toContain('Next:');
    expect(container.querySelector('[data-testid="overview-next-schedule-row"]')?.getAttribute('aria-label'))
      .toBe('Open schedules: Nightly sweep, in 12m');
  });

  test('hides the next-schedule row when the store has no schedules', () => {
    useKookrStore.setState({ schedules: [] });
    render();

    expect(container.querySelector('[data-testid="overview-next-schedule"]')).toBeNull();
    expect(container.textContent).not.toContain('Next scheduled');
  });

  test('first-run empty state shows Create a schedule and opens the schedules dialog', () => {
    const onOpenSchedules = vi.fn();
    useKookrStore.setState({ schedules: [] });
    render({ onOpenSchedules });

    const cta = container.querySelector<HTMLButtonElement>('[data-testid="overview-create-schedule"]');
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toBe('Create a schedule');
    expect(container.textContent).toContain('No agents running.');
    expect(container.querySelector('[data-testid="overview-next-schedule"]')).toBeNull();

    act(() => {
      cta?.click();
    });
    expect(onOpenSchedules).toHaveBeenCalledTimes(1);
  });

  test('hides Create a schedule once any schedule exists', () => {
    useKookrStore.setState({
      schedules: [makeSchedule({ name: 'Nightly sweep' })],
    });
    render({ onOpenSchedules: vi.fn() });

    expect(container.querySelector('[data-testid="overview-create-schedule"]')).toBeNull();
    expect(container.textContent).not.toContain('Create a schedule');
    expect(container.querySelector('[data-testid="overview-next-schedule"]')).not.toBeNull();
  });

  test('hides Create a schedule once any task exists even with an empty schedule list', () => {
    useKookrStore.setState({ schedules: [] });
    render({
      running: [makeRunningAgent('run-1', 'Watch logs')],
      onOpenSchedules: vi.fn(),
    });

    expect(container.querySelector('[data-testid="overview-create-schedule"]')).toBeNull();
    expect(container.textContent).not.toContain('Create a schedule');
  });

  test('hides Create a schedule when only completed tasks remain and the schedule list is empty', () => {
    useKookrStore.setState({ schedules: [] });
    render({
      completed: [makeCompletedAgent('done-1', 'Ship the fix')],
      onOpenSchedules: vi.fn(),
    });

    expect(container.textContent).toContain('All clear — agents working autonomously.');
    expect(container.querySelector('[data-testid="overview-create-schedule"]')).toBeNull();
    expect(container.textContent).not.toContain('Create a schedule');
  });

  test('labels a disabled schedule paused instead of a next-fire time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'));
    useKookrStore.setState({
      schedules: [makeSchedule({
        name: 'Paused nightly',
        enabled: false,
        nextRunAt: '2026-06-20T10:12:00.000Z',
      })],
    });
    render();

    const row = container.querySelector('[data-testid="overview-next-schedule-row"]');
    expect(row?.textContent).toContain('Paused nightly');
    expect(row?.textContent).toContain('paused');
    expect(row?.textContent).not.toContain('in 12m');
  });

  test('labels an exhausted schedule exhausted instead of a next-fire time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'));
    useKookrStore.setState({
      schedules: [makeSchedule({
        name: 'Weekly review',
        stopReason: 'trigger_limit_reached',
        nextRunAt: '2026-06-20T10:12:00.000Z',
      })],
    });
    render();

    const row = container.querySelector('[data-testid="overview-next-schedule-row"]');
    expect(row?.textContent).toContain('Weekly review');
    expect(row?.textContent).toContain('exhausted');
    expect(row?.textContent).not.toContain('in 12m');
  });

  test('clicking the next-schedule row calls onOpenSchedules', () => {
    const onOpenSchedules = vi.fn();
    useKookrStore.setState({
      schedules: [makeSchedule({ name: 'Nightly sweep' })],
    });
    render({ onOpenSchedules });

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="overview-next-schedule-row"]')?.click();
    });
    expect(onOpenSchedules).toHaveBeenCalledTimes(1);
  });

  test('does not list recently completed tasks when the completed bucket is empty', () => {
    render();

    expect(container.querySelector('[data-testid="overview-recent-completed"]')).toBeNull();
    expect(container.textContent).not.toContain('Recently completed');
    expect(container.querySelector('[data-testid="overview-completed-open"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-completed-relaunch"]')).toBeNull();
  });

  test('lists up to three most recently finished tasks by name', () => {
    render({
      completed: [
        makeCompletedAgent('old', 'Oldest done', { finishedAt: '2026-06-20T09:00:00.000Z' }),
        makeCompletedAgent('newest', 'Newest done', { finishedAt: '2026-06-20T12:00:00.000Z' }),
        makeCompletedAgent('middle', 'Middle done', { finishedAt: '2026-06-20T11:00:00.000Z' }),
        makeCompletedAgent('fourth', 'Should stay in the rail', { finishedAt: '2026-06-20T08:00:00.000Z' }),
      ],
    });

    const section = container.querySelector('[data-testid="overview-recent-completed"]');
    expect(section).not.toBeNull();
    expect(container.textContent).toContain('Recently completed');
    const names = Array.from(section?.querySelectorAll('.overview-completed-name') ?? [])
      .map((el) => el.textContent);
    expect(names).toEqual(['Newest done', 'Middle done', 'Oldest done']);
    expect(names).toHaveLength(OVERVIEW_RECENT_COMPLETED_LIMIT);
    expect(container.textContent).not.toContain('Should stay in the rail');
    expect(container.textContent).toContain('+1 more in Completed');
  });

  test('does not show an overflow line when exactly three completed tasks exist', () => {
    render({
      completed: [
        makeCompletedAgent('a', 'First', { finishedAt: '2026-06-20T12:00:00.000Z' }),
        makeCompletedAgent('b', 'Second', { finishedAt: '2026-06-20T11:00:00.000Z' }),
        makeCompletedAgent('c', 'Third', { finishedAt: '2026-06-20T10:00:00.000Z' }),
      ],
    });

    expect(container.querySelectorAll('.overview-completed-name')).toHaveLength(3);
    expect(container.textContent).not.toContain('more in Completed');
  });

  test('Open selects the completed task from the overview', () => {
    const completed = [makeCompletedAgent('done-1', 'Ship the fix')];
    useKookrStore.setState({ agents: completed });
    render({ completed });

    const open = container.querySelector<HTMLButtonElement>('[data-testid="overview-completed-open"]');
    expect(open).not.toBeNull();
    expect(open?.getAttribute('aria-label')).toBe('Open Ship the fix');
    act(() => {
      open?.click();
    });
    expect(useKookrStore.getState().selectedAgentId).toBe('done-1');
    expect(useKookrStore.getState().selectedTaskId).toBe('task-done-1');
  });

  test('hides Relaunch when a legacy playbook row has no task id for lineage', () => {
    render({
      completed: [makeCompletedAgent('done-1', 'Ship the fix', {
        taskId: undefined,
        playbookId: 'ship.md',
        playbookParameterValues: { repo: 'kookr-ai/kookr' },
      })],
    });

    expect(container.textContent).toContain('Ship the fix');
    expect(container.querySelector('[data-testid="overview-completed-open"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="overview-completed-relaunch"]')).toBeNull();
  });

  test('Relaunch prefills Launch with the completed task prompt, cwd, criteria, and agent type', async () => {
    vi.mocked(getTask).mockResolvedValue({
      prompt: 'Ship the dashboard next actions slice',
      cwd: '/tmp/kookr',
      criteria: 'Merged PR, tests green',
      agentType: 'claude-code',
    });
    render({
      completed: [makeCompletedAgent('done-1', 'Ship the fix', { taskId: 'task-done-1' })],
    });

    const relaunch = container.querySelector<HTMLButtonElement>('[data-testid="overview-completed-relaunch"]');
    expect(relaunch).not.toBeNull();
    expect(relaunch?.getAttribute('aria-label')).toBe('Relaunch Ship the fix');
    await act(async () => {
      relaunch?.click();
    });

    expect(getTask).toHaveBeenCalledWith('task-done-1');
    expect(useKookrStore.getState().relaunchTask).toEqual({
      sourceTaskId: 'task-done-1',
      prompt: 'Ship the dashboard next actions slice',
      cwd: '/tmp/kookr',
      criteria: 'Merged PR, tests green',
      agentType: 'claude-code',
    });
  });

  describe('recently completed evidence markers (#2851)', () => {
    function evidence(agentId = 'done-1') {
      const row = Array.from(container.querySelectorAll('.overview-completed-row')).find((el) =>
        el.querySelector('[data-testid="overview-completed-open"]'),
      );
      return {
        block: container.querySelector('[data-testid="overview-completed-evidence"]'),
        testsTag: container.querySelector('[data-testid="overview-completed-evidence-tests"]'),
        prBlock: container.querySelector('[data-testid="overview-completed-evidence-prs"]'),
        prLinks: Array.from(
          container.querySelectorAll<HTMLAnchorElement>('.overview-completed-pr-link'),
        ),
        row,
      };
    }

    test('shows no evidence markers when the completed row has no digest', () => {
      render({ completed: [makeCompletedAgent('done-1', 'Ship the fix')] });

      expect(container.querySelector('[data-testid="overview-recent-completed"]')).not.toBeNull();
      expect(evidence().block).toBeNull();
      // The row itself (name + Open) is otherwise unchanged.
      expect(container.querySelector('[data-testid="overview-completed-open"]')).not.toBeNull();
    });

    test('renders no evidence markers when the digest has only bullets/filesChanged', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: { bullets: ['did a thing'], filesChanged: ['a.ts'] },
          }),
        ],
      });

      expect(evidence().block).toBeNull();
    });

    test('a test summary produces a neutral Tests tag — never a pass/verified claim', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              testSummary: '42 passed, 0 failed',
            },
          }),
        ],
      });

      const { testsTag, prBlock } = evidence();
      expect(testsTag?.textContent).toBe('Tests');
      // The full summary is available on hover but the visible label stays neutral.
      expect(testsTag?.getAttribute('title')).toBe('42 passed, 0 failed');
      expect(testsTag?.textContent).not.toMatch(/verified|passed|✓/i);
      expect(prBlock).toBeNull();
    });

    test('failing test text still shows the neutral Tests tag, not a failure/success verdict', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              testSummary: '3 failed, 39 passed',
            },
          }),
        ],
      });

      const { testsTag } = evidence();
      // Presence of a summary — not its content — drives the neutral label.
      expect(testsTag?.textContent).toBe('Tests');
      expect(testsTag?.getAttribute('title')).toBe('3 failed, 39 passed');
    });

    test('a whitespace-only test summary falls through to the command-based Verification evidence tag', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              testSummary: '   ',
              verificationCommands: ['pnpm test'],
            },
          }),
        ],
      });

      // A blank summary is not evidence; the recorded command is, so the label
      // reflects the command evidence rather than showing an empty Tests tag.
      expect(evidence().testsTag?.textContent).toBe('Verification evidence');
    });

    test('a whitespace-only test summary with no other evidence renders nothing', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              testSummary: '   ',
            },
          }),
        ],
      });

      expect(evidence().block).toBeNull();
    });

    test('command-only evidence (no test summary) shows a Verification evidence tag', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              verificationCommands: ['pnpm test', 'pnpm lint'],
            },
          }),
        ],
      });

      const { testsTag, prBlock } = evidence();
      expect(testsTag?.textContent).toBe('Verification evidence');
      expect(prBlock).toBeNull();
    });

    test('a single PR renders one actionable, accessible link labelled by number', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              prUrls: ['https://github.com/kookr-ai/kookr/pull/2851'],
            },
          }),
        ],
      });

      const { testsTag, prLinks } = evidence();
      expect(testsTag).toBeNull();
      expect(prLinks).toHaveLength(1);
      expect(prLinks[0].textContent).toContain('PR #2851');
      expect(prLinks[0].href).toBe('https://github.com/kookr-ai/kookr/pull/2851');
      expect(prLinks[0].target).toBe('_blank');
      expect(prLinks[0].rel).toBe('noopener noreferrer');
      // Accessible label describes the action + destination, not color alone.
      expect(prLinks[0].getAttribute('aria-label')).toBe(
        'Open PR #2851 for Ship the fix (opens in new tab)',
      );
    });

    test('multiple PRs each stay discoverable rather than collapsing to the first', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              prUrls: [
                'https://github.com/kookr-ai/kookr/pull/2851',
                'https://github.com/kookr-ai/kookr/pull/2862',
              ],
            },
          }),
        ],
      });

      const { prLinks } = evidence();
      expect(prLinks).toHaveLength(2);
      expect(prLinks.map((a) => a.href)).toEqual([
        'https://github.com/kookr-ai/kookr/pull/2851',
        'https://github.com/kookr-ai/kookr/pull/2862',
      ]);
      expect(prLinks.map((a) => a.textContent)).toEqual([
        expect.stringContaining('PR #2851'),
        expect.stringContaining('PR #2862'),
      ]);
    });

    test('a non-GitHub-numbered PR url falls back to a generic View PR label', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              prUrls: ['https://example.com/review/abc'],
            },
          }),
        ],
      });

      const { prLinks } = evidence();
      expect(prLinks).toHaveLength(1);
      expect(prLinks[0].textContent).toContain('View PR');
    });

    test('blank/whitespace PR urls are dropped so no dead link renders', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              prUrls: ['   '],
            },
          }),
        ],
      });

      expect(evidence().block).toBeNull();
    });

    test('caps at two evidence types: a tests tag plus PR links, and nothing more', () => {
      render({
        completed: [
          makeCompletedAgent('done-1', 'Ship the fix', {
            completionDigest: {
              bullets: [],
              filesChanged: [],
              testSummary: '10 passed',
              verificationCommands: ['pnpm test'],
              prUrls: ['https://github.com/kookr-ai/kookr/pull/2851'],
            },
          }),
        ],
      });

      const { block, testsTag, prBlock } = evidence();
      expect(testsTag?.textContent).toBe('Tests');
      expect(prBlock).not.toBeNull();
      // Exactly two evidence-type containers under the block: the tests tag and
      // the PR block. A test summary + verification commands still collapse to
      // one tests type, never two.
      expect(block?.childElementCount).toBe(2);
      expect(block?.querySelectorAll('[data-testid="overview-completed-evidence-tests"]')).toHaveLength(1);
    });

    test('terminal non-completed rows show neutral evidence with no success wording', () => {
      render({
        completed: [
          makeCompletedAgent('cancelled-1', 'Abandoned task', {
            taskStatus: 'cancelled',
            completionDigest: {
              bullets: [],
              filesChanged: [],
              testSummary: '2 failed',
              prUrls: ['https://github.com/kookr-ai/kookr/pull/2851'],
            },
          }),
        ],
      });

      const { block, testsTag, prLinks } = evidence();
      expect(block).not.toBeNull();
      // A cancelled task gains no success/delivery/merge semantics from markers.
      expect(testsTag?.textContent).toBe('Tests');
      expect(block?.textContent).not.toMatch(/verified|passed|merged|delivered/i);
      expect(prLinks).toHaveLength(1);
      expect(prLinks[0].getAttribute('aria-label')).not.toMatch(/merged|delivered/i);
    });
  });

  describe('runtime mix (#2670)', () => {
    test('tallies runtimes across every live bucket, omitting zero runtimes', () => {
      render({
        waiting: [
          makeWaitingAgent('w-1', 'Fix the build', { agentType: 'claude-code' }),
          makeWaitingAgent('w-2', 'Review the diff', { agentType: 'codex-cli' }),
        ],
        running: [
          makeRunningAgent('r-1', 'Watch logs', { agentType: 'claude-code' }),
          makeRunningAgent('r-2', 'Ship it', { agentType: 'claude-code' }),
          makeRunningAgent('r-3', 'Explore', { agentType: 'grok-build' }),
        ],
        completed: [makeCompletedAgent('c-1', 'Ship the fix', { agentType: 'codex-cli' })],
      });

      const mix = container.querySelector('[data-testid="overview-runtime-mix"]');
      // Canonical order Claude → Codex → Grok; counts span waiting + running + completed.
      expect(mix?.textContent).toBe('Claude 3 · Codex 2 · Grok 1');
    });

    test('shows a single entry when every live agent is one runtime', () => {
      render({
        waiting: [makeWaitingAgent('w-1', 'Fix the build', { agentType: 'claude-code' })],
        running: [makeRunningAgent('r-1', 'Watch logs', { agentType: 'claude-code' })],
        completed: [makeCompletedAgent('c-1', 'Ship the fix', { agentType: 'claude-code' })],
      });

      const mix = container.querySelector('[data-testid="overview-runtime-mix"]');
      expect(mix?.textContent).toBe('Claude 3');
    });

    test('surfaces an unknown/legacy agentType by its raw value, after known runtimes', () => {
      render({
        running: [
          makeRunningAgent('r-1', 'Watch logs', { agentType: 'claude-code' }),
          // Legacy value not in the known set — labelled verbatim, not dropped.
          makeRunningAgent('r-2', 'Old run', { agentType: 'gemini-cli' as AgentState['agentType'] }),
        ],
      });

      const mix = container.querySelector('[data-testid="overview-runtime-mix"]');
      expect(mix?.textContent).toBe('Claude 1 · gemini-cli 1');
    });

    test('sorts multiple unknown/legacy runtimes alphabetically after known runtimes', () => {
      render({
        running: [
          makeRunningAgent('r-1', 'Watch logs', { agentType: 'zeta-cli' as AgentState['agentType'] }),
          makeRunningAgent('r-2', 'Ship it', { agentType: 'claude-code' }),
          makeRunningAgent('r-3', 'Explore', { agentType: 'alpha-cli' as AgentState['agentType'] }),
        ],
      });

      const mix = container.querySelector('[data-testid="overview-runtime-mix"]');
      // Known runtime first; unknowns follow in alphabetical order (alpha before zeta).
      expect(mix?.textContent).toBe('Claude 1 · alpha-cli 1 · zeta-cli 1');
    });

    test('skips agents with no agentType so untyped agents never appear in the mix', () => {
      render({
        // makeWaitingAgent / makeRunningAgent leave agentType undefined by default.
        waiting: [makeWaitingAgent('w-1', 'Untyped waiting')],
        running: [
          makeRunningAgent('r-1', 'Untyped running'),
          makeRunningAgent('r-2', 'Typed running', { agentType: 'claude-code' }),
        ],
      });

      const mix = container.querySelector('[data-testid="overview-runtime-mix"]');
      // Two untyped agents are skipped; only the one typed Claude agent is tallied.
      expect(mix?.textContent).toBe('Claude 1');
    });

    test('renders no runtime mix line when every live agent lacks an agentType', () => {
      render({
        waiting: [makeWaitingAgent('w-1', 'Untyped waiting')],
        running: [makeRunningAgent('r-1', 'Untyped running')],
      });

      // Tasks exist (counts show), but no runtime is nameable → no mix line.
      expect(container.querySelector('[data-testid="overview-runtime-mix"]')).toBeNull();
    });

    test('renders no runtime mix line when there are no tasks', () => {
      render();
      expect(container.querySelector('[data-testid="overview-runtime-mix"]')).toBeNull();
    });
  });
});
