// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel, summarizeFindingSeverities } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';
import type { AnomalySeverity } from '../../shared/contracts/anomalies.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeFinding(agentId: string, severity: AnomalySeverity): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `${agentId} task`,
    description: 'Working',
    events: [],
    anomaly: {
      type: 'needs_input',
      severity,
      explanation: `${severity} finding`,
      detectedAt: '2026-07-19T00:00:00.000Z',
    },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
  } as AgentState;
}

function renderPanel(root: Root, findings: AgentState[]) {
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings,
      healthy: [],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      send: vi.fn(),
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
}

describe('summarizeFindingSeverities', () => {
  // The expected order below intentionally mirrors the CLI's `SEVERITIES`
  // (`bin/kookr-status.js`), which the dependency-free CLI hardcodes and this
  // frontend hardcodes in turn (`FINDINGS_SEVERITY_ORDER`). There is no shared
  // runtime constant to import, so this asserts the frontend's own order; keep
  // it in lockstep with the CLI when either list changes.
  test('orders severities critical → warning → info (mirroring the CLI order)', () => {
    const summary = summarizeFindingSeverities([
      makeFinding('a', 'info'),
      makeFinding('b', 'critical'),
      makeFinding('c', 'warning'),
      makeFinding('d', 'critical'),
    ]);
    expect(summary).toEqual([
      { severity: 'critical', count: 2 },
      { severity: 'warning', count: 1 },
      { severity: 'info', count: 1 },
    ]);
  });

  test('omits zero-count severities', () => {
    const summary = summarizeFindingSeverities([
      makeFinding('a', 'warning'),
      makeFinding('b', 'warning'),
    ]);
    expect(summary).toEqual([{ severity: 'warning', count: 2 }]);
  });

  test('skips findings without an anomaly', () => {
    const withoutAnomaly = { ...makeFinding('x', 'critical'), anomaly: undefined } as AgentState;
    expect(summarizeFindingSeverities([withoutAnomaly])).toEqual([]);
  });

  test('skips anomaly-less findings while still counting the ones that carry a severity', () => {
    const withoutAnomaly = { ...makeFinding('x', 'critical'), anomaly: undefined } as AgentState;
    expect(
      summarizeFindingSeverities([withoutAnomaly, makeFinding('c', 'critical')]),
    ).toEqual([{ severity: 'critical', count: 1 }]);
  });

  test('is empty for no findings', () => {
    expect(summarizeFindingSeverities([])).toEqual([]);
  });
});

describe('FindingsPanel severity header summary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
    document.body.innerHTML = '';
  });

  const summary = () => container.querySelector<HTMLElement>('[data-testid="findings-severity-summary"]');

  test('renders a compact breakdown in severity order (critical first), beside the active count', () => {
    renderPanel(root, [
      makeFinding('info-1', 'info'),
      makeFinding('crit-1', 'critical'),
      makeFinding('warn-1', 'warning'),
      makeFinding('crit-2', 'critical'),
    ]);

    expect(container.querySelector('.findings-count')?.textContent).toBe('4 active');

    const el = summary();
    expect(el).not.toBeNull();
    // Critical first, then warning, then info, separated by a middot.
    expect(el?.textContent?.replace(/\s+/g, ' ').trim()).toBe('2 critical · 1 warning · 1 info');
    // role="img" + aria-label gives assistive tech one coherent announcement
    // instead of the fragmented child spans.
    expect(el?.getAttribute('role')).toBe('img');
    expect(el?.getAttribute('aria-label')).toBe('Severity breakdown: 2 critical, 1 warning, 1 info');
  });

  test('single-severity case renders just that severity', () => {
    renderPanel(root, [
      makeFinding('crit-1', 'critical'),
      makeFinding('crit-2', 'critical'),
      makeFinding('crit-3', 'critical'),
    ]);

    const el = summary();
    expect(el?.textContent?.replace(/\s+/g, ' ').trim()).toBe('3 critical');
    expect(el?.querySelector('.findings-severity-summary-sep')).toBeNull();
    expect(
      container.querySelector('[data-testid="findings-severity-summary-warning"]'),
    ).toBeNull();
  });

  test('no findings renders no severity summary', () => {
    renderPanel(root, []);
    expect(container.querySelector('.findings-count')?.textContent).toBe('0 active');
    expect(summary()).toBeNull();
  });
});
