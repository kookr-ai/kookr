// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SweepReport as SweepReportData, SweepReportRow } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { SweepReport } from './SweepReport.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeRow(overrides: Partial<SweepReportRow> & Pick<SweepReportRow, 'bucket'>): SweepReportRow {
  return {
    projectId: 'github.com/acme/default-project',
    worktreePath: '/repos/acme/default-wt',
    branch: 'feat/default',
    classification: 'merged',
    reasonCode: 'merged_clean',
    footprintBytes: null,
    lastTouchedMs: null,
    reason: 'Default reason.',
    ...overrides,
  };
}

function makeReport(overrides: Partial<SweepReportData> = {}): SweepReportData {
  const rows: SweepReportRow[] = overrides.rows ?? [
    makeRow({
      bucket: 'removed',
      projectId: 'github.com/acme/proj-removed',
      worktreePath: '/repos/acme/wt-removed',
      branch: 'feat/removed',
      footprintBytes: 2048,
      lastTouchedMs: Date.now() - 1000 * 60 * 60 * 24 * 3,
      reason: 'Merged and removed.',
      disposition: 'completed',
    }),
    makeRow({
      bucket: 'removal_failed',
      projectId: 'github.com/acme/proj-removal-failed',
      worktreePath: '/repos/acme/wt-removal-failed',
      branch: 'feat/removal-failed',
      footprintBytes: 4096,
      lastTouchedMs: Date.now() - 1000 * 60 * 60 * 24 * 5,
      reason: 'Merged but git worktree remove failed.',
      disposition: 'prune_failed',
    }),
    makeRow({
      bucket: 'probably_safe',
      projectId: 'github.com/acme/proj-safe',
      worktreePath: '/repos/acme/wt-safe',
      branch: 'feat/safe',
      classification: 'unique_commits',
      reasonCode: 'stale_unique',
      footprintBytes: null,
      lastTouchedMs: null,
      reason: 'Stale unique commits, no sensitive files.',
    }),
    makeRow({
      bucket: 'needs_call',
      projectId: 'github.com/acme/proj-needs-call',
      worktreePath: '/repos/acme/wt-needs-call',
      branch: 'feat/needs-call',
      classification: 'dirty',
      reasonCode: 'dirty_uncommitted',
      footprintBytes: 5_000_000,
      lastTouchedMs: Date.now() - 1000 * 60 * 30,
      reason: 'Has uncommitted changes.',
    }),
    makeRow({
      bucket: 'blocked',
      projectId: 'github.com/acme/proj-blocked',
      worktreePath: '/repos/acme/wt-blocked',
      branch: 'feat/blocked',
      classification: 'busy',
      reasonCode: 'busy_lease',
      footprintBytes: 1000,
      lastTouchedMs: Date.now(),
      reason: 'Currently leased by another agent.',
    }),
  ];

  return {
    runId: 'run-1',
    generatedAt: new Date().toISOString(),
    thresholdDays: 14,
    rows,
    buckets: {
      removed: { count: 1, footprintBytesUpperBound: 2048, unknownFootprintCount: 0 },
      removal_failed: { count: 1, footprintBytesUpperBound: 4096, unknownFootprintCount: 0 },
      probably_safe: { count: 1, footprintBytesUpperBound: 0, unknownFootprintCount: 1 },
      needs_call: { count: 1, footprintBytesUpperBound: 5_000_000, unknownFootprintCount: 0 },
      blocked: { count: 1, footprintBytesUpperBound: 1000, unknownFootprintCount: 0 },
    },
    notAnalyzed: [],
    ...overrides,
  };
}

describe('SweepReport', () => {
  let container: HTMLDivElement;
  let root: Root;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    send = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    syncGlobalStore();
    container.remove();
  });

  function render() {
    act(() => {
      root.render(<SweepReport send={send} />);
    });
  }

  test('renders bucket section headers with correct counts, collapses Blocked, and tags removal_failed rows', () => {
    useKookrStore.setState({ sweepReport: makeReport(), sweepReportOpen: true });

    render();

    expect(container.textContent).toContain('Removed (2)');
    expect(container.textContent).toContain('Probably safe to remove (1)');
    expect(container.textContent).toContain('Needs your call (1)');
    expect(container.textContent).toContain('1 blocked (busy / protected / checked out elsewhere / unknown)');

    // Blocked rows are collapsed to a count only — no row detail in the DOM.
    expect(container.textContent).not.toContain('/repos/acme/wt-blocked');
    expect(container.textContent).not.toContain('feat/blocked');

    // removal_failed row is visually distinguished from a plain removed row.
    expect(container.textContent).toContain('removal failed — still on disk');
  });

  test('shows "size unknown" for a null footprint and a formatted size for a known footprint', () => {
    useKookrStore.setState({ sweepReport: makeReport(), sweepReportOpen: true });

    render();

    expect(container.textContent).toContain('size unknown');
    // 5,000,000 bytes ≈ 4.8 MB.
    expect(container.textContent).toMatch(/MB/);
  });

  test('renders a loud not-analyzed banner with the project and count', () => {
    useKookrStore.setState({
      sweepReport: makeReport({
        notAnalyzed: [{ projectId: 'github.com/acme/timed-out-project', code: 'timeout', notAnalyzedCount: 3 }],
      }),
      sweepReportOpen: true,
    });

    render();

    const banner = container.querySelector('[data-testid="sweep-report-not-analyzed"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('not analyzed');
    expect(banner?.textContent).toContain('3 worktree(s)');
    expect(banner?.textContent).toContain('timeout');
  });

  test('clicking "Run diagnostic" on a needs-your-call row requests a fresh cleanup detail', () => {
    useKookrStore.setState({ sweepReport: makeReport(), sweepReportOpen: true });

    render();

    const button = Array.from(container.querySelectorAll('[data-testid="sweep-report-run-diagnostic"]'))
      .find((el) => el.textContent === 'Run diagnostic');
    expect(button).toBeDefined();

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(send).toHaveBeenCalledWith({
      type: 'workspace:getCleanupDetail',
      projectId: 'github.com/acme/proj-needs-call',
      worktreePath: '/repos/acme/wt-needs-call',
    });
  });

  test('offers to reopen the last sweep report from the reconnect snapshot when closed and no live report', () => {
    useKookrStore.setState({ sweepReport: null, sweepReportOpen: false, lastSweepRunId: 'run-42' });

    render();

    const button = container.querySelector('[data-testid="sweep-report-view-last"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('View last sweep report');

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(send).toHaveBeenCalledWith({ type: 'workspace:requestSweepReport', runId: 'run-42' });
  });

  test('renders nothing when closed with no report and no last run id', () => {
    useKookrStore.setState({ sweepReport: null, sweepReportOpen: false, lastSweepRunId: null });

    render();

    expect(container.textContent).toBe('');
  });

  test('re-opens an in-memory report (no server round-trip) after it was closed', () => {
    useKookrStore.setState({ sweepReport: makeReport(), sweepReportOpen: false, lastSweepRunId: 'run-1' });

    render();

    // The live report is still in memory → instant re-open affordance, not the
    // ledger-reconstruction request.
    expect(container.querySelector('[data-testid="sweep-report-view-last"]')).toBeNull();
    const button = container.querySelector('[data-testid="sweep-report-view"]');
    expect(button).not.toBeNull();

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(send).not.toHaveBeenCalled();
    expect(useKookrStore.getState().sweepReportOpen).toBe(true);
    expect(container.querySelector('[data-testid="sweep-report-panel"]')).not.toBeNull();
  });

  test('closing the panel via the close button hides it', () => {
    useKookrStore.setState({ sweepReport: makeReport(), sweepReportOpen: true });

    render();

    expect(container.querySelector('[data-testid="sweep-report-panel"]')).not.toBeNull();

    const closeButton = container.querySelector('[data-testid="sweep-report-close"]');
    expect(closeButton).not.toBeNull();

    act(() => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useKookrStore.getState().sweepReportOpen).toBe(false);
    expect(container.querySelector('[data-testid="sweep-report-panel"]')).toBeNull();
  });
});
