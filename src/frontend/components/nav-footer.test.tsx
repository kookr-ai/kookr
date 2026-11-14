// @vitest-environment happy-dom
/**
 * Navigation footer and the status bar's other contents (#3561 slice 5b,
 * variant B "triage inbox"). The status bar is gone:
 * - spend and quota sit in the navigation footer (and the System detail);
 * - "N tasks · M findings" sits in the list header;
 * - the oldest-wait chip sits on the right of the "Needs you" header;
 * - the reflection prompt is a notice at the top of the list.
 * The icon-rail and phone layouts are CSS-only; they were measured in Chromium
 * for the PR (no committed Playwright spec covers them).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UsageSummary } from './UsageSummary.js';
import { ProjectSidebar } from './ProjectSidebar.js';
import { FindingsPanel } from './FindingsPanel.js';
import { ReflectionPrompt } from './ReflectionPrompt.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetProjectNotificationMuteForTests } from '../hooks/useProjectNotificationMute.js';
import type { AgentState, ProjectSummary } from '../../shared/protocol.js';

const NOW = new Date('2026-11-11T12:00:00.000Z').getTime();

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function quota(fiveHour: number, sevenDay: number) {
  return {
    fiveHour: { utilization: fiveHour, resetsAt: new Date(NOW + 90 * 60_000).toISOString() },
    sevenDay: { utilization: sevenDay, resetsAt: new Date(NOW + 3 * 24 * 60 * 60_000).toISOString() },
    updatedAt: NOW,
  };
}

function summary(project: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project,
    displayName: project,
    color: 1,
    activeAgents: 1,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openContributionAttempts: 0,
    recentTasks: [],
    tracked: true,
    ...extra,
  };
}

function finding(agentId: string, detectedAt: string): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `${agentId} task`,
    description: 'Waiting',
    events: [],
    anomaly: { type: 'needs_input', severity: 'warning', explanation: 'needs you', detectedAt },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
  } as unknown as AgentState;
}

describe('navigation footer: spend and quota (#3561 slice 5b)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let localStore: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function render(element: React.ReactElement) {
    act(() => root.render(element));
  }

  test('shows 24h spend, all-time spend and both quota windows with bars', () => {
    useKookrStore.setState({ quotaStatus: quota(31, 62), totalSpendUsd: 1234.5 });
    render(<UsageSummary
      placement="nav"
      cost24h={{ costUsd: 47.25, readiness: 'ready', costCoverage: 1 }}
    />);

    const footer = container.querySelector('[data-testid="nav-footer"]');
    expect(footer?.getAttribute('aria-label')).toBe('Spend and quota');
    expect(container.querySelector('[data-testid="system-usage-heading"]')).toBeNull();
    expect(footer?.querySelector('[data-testid="cost-24h-chip"]')?.textContent).toBe('$47.25 (24h)');
    expect(footer?.querySelector('[data-testid="all-time-spend"]')?.textContent).toBe('$1234.50');

    const fiveHour = footer?.querySelector<HTMLElement>('[data-testid="usage-quota-5h"]');
    expect(fiveHour?.querySelector('.usage-label-long')?.textContent).toBe('5-hour quota');
    expect(fiveHour?.querySelector('.usage-label-short')?.textContent).toBe('5h');
    expect(fiveHour?.querySelector('.usage-value')?.textContent).toBe('31% (1h 30m)');
    expect(fiveHour?.querySelector<HTMLElement>('.usage-bar > i')?.style.width).toBe('31%');
    expect(fiveHour?.classList.contains('quota-low')).toBe(true);
    expect(fiveHour?.getAttribute('title')).toContain('resets in 1h 30m');

    const sevenDay = footer?.querySelector<HTMLElement>('[data-testid="usage-quota-7d"]');
    expect(sevenDay?.querySelector('.usage-value')?.textContent).toBe('62% (3d)');
    expect(sevenDay?.classList.contains('quota-medium')).toBe(true);
  });

  test('both spend figures open Cost Comparison', () => {
    const onOpenCostComparison = vi.fn();
    useKookrStore.setState({ totalSpendUsd: 12.3 });
    render(<UsageSummary
      placement="nav"
      cost24h={{ costUsd: 4, readiness: 'ready', costCoverage: 1 }}
      onOpenCostComparison={onOpenCostComparison}
    />);

    const allTime = container.querySelector<HTMLButtonElement>('[data-testid="all-time-spend"]');
    expect(allTime?.tagName).toBe('BUTTON');
    expect(allTime?.getAttribute('aria-label')).toBe('$12.30 all-time. Open Cost Comparison');
    act(() => allTime!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="cost-24h-chip"]')!.click());
    expect(onOpenCostComparison).toHaveBeenCalledTimes(2);
  });

  test('a critical quota reads red and a stale sample says how old it is', () => {
    useKookrStore.setState({
      quotaStatus: { ...quota(97, 10), updatedAt: NOW - 12 * 60_000 },
    });
    render(<UsageSummary placement="nav" />);

    const fiveHour = container.querySelector<HTMLElement>('[data-testid="usage-quota-5h"]');
    expect(fiveHour?.classList.contains('quota-critical')).toBe(true);
    expect(fiveHour?.getAttribute('title')).toContain('Quota data is 12m old');
    expect(container.querySelector('.usage-quotas.quota-stale')).not.toBeNull();
  });

  test('renders nothing when there is no spend, quota or 24h count yet', () => {
    useKookrStore.setState({ quotaStatus: null, totalSpendUsd: 0 });
    render(<UsageSummary placement="nav" cost24h={null} />);
    expect(container.innerHTML).toBe('');
  });

  test('an empty System summary leaves no orphan Usage heading', () => {
    useKookrStore.setState({ quotaStatus: null, totalSpendUsd: 0 });
    render(<UsageSummary placement="system" cost24h={null} />);
    expect(container.innerHTML).toBe('');
  });

  test('without quota the footer is marked so the icon rail can hide it', () => {
    useKookrStore.setState({ quotaStatus: null, totalSpendUsd: 5 });
    render(<UsageSummary placement="nav" />);
    expect(container.querySelector('[data-testid="nav-footer"]')?.classList.contains('usage-summary--no-quota')).toBe(true);
  });

  test('the System placement is the same summary under its own test id', () => {
    useKookrStore.setState({ quotaStatus: quota(10, 20), totalSpendUsd: 0 });
    render(<UsageSummary placement="system" launchedLast24h={2} completedLast24h={1} />);

    expect(container.querySelector('[data-testid="system-usage-heading"]')?.textContent).toBe('Usage');
    const usage = container.querySelector('[data-testid="system-usage"]');
    expect(usage?.classList.contains('usage-summary--system')).toBe(true);
    expect(usage?.querySelector('[data-testid="launched-24h-chip"]')?.textContent).toBe('2 launched / 24h');
    expect(usage?.querySelector('[data-testid="completed-24h-chip"]')?.textContent).toBe('1 completed / 24h');
    expect(usage?.querySelector('[data-testid="usage-quota-7d"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="nav-footer"]')).toBeNull();
  });

  test('the navigation renders the footer last, after the organizer button', () => {
    useKookrStore.getState().handleProjectSummaries([summary('github.com/org/live')]);
    useKookrStore.setState({ quotaStatus: quota(31, 62) });
    render(<ProjectSidebar
      onManage={vi.fn()}
      footer={<UsageSummary placement="nav" />}
    />);

    const nav = container.querySelector('[data-testid="project-sidebar"]');
    expect(nav?.lastElementChild?.getAttribute('data-testid')).toBe('nav-footer');
    expect(nav?.querySelector('[data-testid="nav-footer"]')?.previousElementSibling?.classList.contains('project-sidebar-organizer')).toBe(true);
  });
});

describe('list header: counts, oldest wait and the reflection notice (#3561 slice 5b)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
      text: async () => '{}',
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function renderPanel(props: Partial<React.ComponentProps<typeof FindingsPanel>> = {}) {
    act(() => {
      root.render(<FindingsPanel
        findings={[]}
        healthy={[]}
        pending={[]}
        snoozed={[]}
        completed={[]}
        selectedAgentId={null}
        selectedTaskId={null}
        send={vi.fn()}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
        {...props}
      />);
    });
  }

  test('the header carries the task and finding counts App passes', () => {
    renderPanel({
      findings: [finding('a', new Date(NOW - 5 * 60_000).toISOString())],
      totalTasks: 7,
    });
    expect(container.querySelector('[data-testid="task-counts"]')?.textContent).toBe('7 tasks · 1 finding');
  });

  test('singular and empty forms match the old status bar text', () => {
    renderPanel({ totalTasks: 1 });
    expect(container.querySelector('[data-testid="task-counts"]')?.textContent).toBe('1 task · 0 findings');
  });

  test('the oldest-wait chip sits in the "Needs you" header and selects the finding', () => {
    const onSelectOldestFinding = vi.fn();
    const older = new Date(NOW - 12 * 60_000);
    renderPanel({
      findings: [finding('a', new Date(NOW - 3 * 60_000).toISOString()), finding('b', older.toISOString())],
      oldestFindingWaitStartedAt: older,
      onSelectOldestFinding,
    });

    const header = container.querySelector('[data-testid="findings-needs-you-header"]');
    const chip = header?.querySelector<HTMLButtonElement>('[data-testid="oldest-finding-wait-chip"]');
    expect(chip?.textContent).toBe('oldest 12m');
    act(() => chip!.click());
    expect(onSelectOldestFinding).toHaveBeenCalledOnce();
  });

  test('no oldest-wait chip when nothing is waiting', () => {
    renderPanel({ totalTasks: 2, oldestFindingWaitStartedAt: new Date(NOW - 60_000) });
    expect(container.querySelector('[data-testid="oldest-finding-wait-chip"]')).toBeNull();
  });

  test('a notice renders at the top of the list', () => {
    const onReflect = vi.fn();
    const onDismiss = vi.fn();
    renderPanel({
      notice: <ReflectionPrompt
        suggestion={{ sessionLabel: '09:00-09:45', summary: 'Busy hour', totalInterventions: 5, totalFindings: 3 }}
        onReflect={onReflect}
        onDismiss={onDismiss}
      />,
    });

    const prompt = container.querySelector('.findings-panel [data-testid="reflection-prompt"]');
    expect(prompt?.textContent).toContain('Reflect on 09:00-09:45');
    expect(prompt?.compareDocumentPosition(container.querySelector('.findings-scroll-area')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const [reflect, dismiss] = Array.from(prompt!.querySelectorAll<HTMLButtonElement>('button'));
    act(() => reflect.click());
    act(() => dismiss.click());
    expect(onReflect).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
