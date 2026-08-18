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

    const gettingStarted = container.querySelector<HTMLAnchorElement>('a.overview-tour-link');
    expect(gettingStarted).not.toBeNull();
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

  test('hides Relaunch when the completed row has no task id', () => {
    render({
      completed: [makeCompletedAgent('done-1', 'Ship the fix', { taskId: undefined })],
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
      prompt: 'Ship the dashboard next actions slice',
      cwd: '/tmp/kookr',
      criteria: 'Merged PR, tests green',
      agentType: 'claude-code',
    });
  });
});
