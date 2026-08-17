// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { open as openOnboardingTour } from '../store/onboarding-store.js';
import { GETTING_STARTED_GUIDE_URL, OverviewEmptyState } from './OverviewEmptyState.js';

vi.mock('../store/onboarding-store.js', () => ({
  open: vi.fn(),
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

describe('OverviewEmptyState', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(openOnboardingTour).mockClear();
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
        runningCount: 0,
        completedCount: 0,
        onLaunch: vi.fn(),
        ...props,
      }));
    });
  }

  test('renders aggregate counts for running / needs input / completed', () => {
    render({
      waiting: [makeWaitingAgent('agent-1', 'Fix the build')],
      runningCount: 3,
      completedCount: 2,
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
    render({ waiting, runningCount: 0, completedCount: 0 });

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

    render({ waiting, runningCount: 0, completedCount: 0 });

    expect(container.querySelector('.overview-waiting-row')?.textContent).toContain('waiting 3d');
  });

  test('shows the no-agents message when there is nothing at all', () => {
    render();

    expect(container.textContent).toContain('No agents running.');
    expect(container.querySelector('.overview-waiting')).toBeNull();
  });

  test('shows the all-clear message when agents run but none need input', () => {
    render({ runningCount: 2 });

    expect(container.textContent).toContain('All clear — agents working autonomously.');
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
    render({ runningCount: 2 });

    expect(container.textContent).toContain('All clear — agents working autonomously.');
    expect(container.querySelector('.overview-tour-reentry')).toBeNull();
    expect(container.querySelector('.overview-tour-link')).toBeNull();
    expect(container.textContent).not.toContain('Getting Started');
    expect(container.textContent).not.toContain('Check setup');
    expect(container.textContent).not.toContain('pnpm run doctor');
  });

  test('does not show the first-run setup links when only completed agents remain', () => {
    render({ completedCount: 1 });

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
});
