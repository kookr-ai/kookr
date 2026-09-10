// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatDetectionStatsSummary } from './detection-stats-format.js';

const getAnomalyStats = vi.fn();
const runDiagnostic = vi.fn();
vi.mock('../api/index.js', () => ({
  getAnomalyStats: (...args: unknown[]) => getAnomalyStats(...args),
  runDiagnostic: (...args: unknown[]) => runDiagnostic(...args),
}));

// Imported after the mock so the component picks up the stubbed api module.
const { DetectionStatsPanel } = await import('./DetectionStatsPanel.js');

describe('formatDetectionStatsSummary', () => {
  test('does not show a per-hour rate during the initial startup window', () => {
    const summary = formatDetectionStatsSummary(
      27,
      '2026-05-08T14:54:00.000Z',
      new Date('2026-05-08T14:57:00.000Z').getTime(),
    );

    expect(summary).toBe('27 findings');
  });

  test('shows per-hour rate once uptime is long enough to be meaningful', () => {
    const summary = formatDetectionStatsSummary(
      27,
      '2026-05-08T13:54:00.000Z',
      new Date('2026-05-08T14:57:00.000Z').getTime(),
    );

    expect(summary).toBe('27 findings · 25.7/hr');
  });
});

describe('DetectionStatsPanel per-type check count', () => {
  let root: Root | null;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    getAnomalyStats.mockReset();
    runDiagnostic.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
  });

  async function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(DetectionStatsPanel, { defaultExpanded: true, showEmpty: true }));
    });
    // Let the fetch effect resolve and re-render with the stats payload. Two
    // microtask ticks match the sibling DetectionStatsPanel.explainers test and
    // stay resilient if the effect ever gains an extra await hop.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  test('renders the check count (fire-rate denominator) for a type with a non-zero rate', async () => {
    getAnomalyStats.mockResolvedValue({
      checks: { stale_agent: 200 },
      fires: { stale_agent: 100 },
      falsePositives: {},
      falseNegatives: {},
    });

    await mount();

    const row = container.querySelector('.stats-row:not(.muted)') as HTMLElement;
    expect(row).not.toBeNull();

    const checks = row.querySelector('.stats-checks') as HTMLElement;
    expect(checks).not.toBeNull();
    expect(checks.textContent).toContain('200 checks');

    // The fire-rate percentage stays alongside the new denominator.
    const rate = row.querySelector('.stats-rate') as HTMLElement;
    expect(rate.textContent).toContain('50.0% fire rate');
  });

  test('renders "0 checks" for a false-negative-only type with no recorded checks', async () => {
    // A type with 0 fires but >0 FNs still appears (user reported a miss). Its
    // check count is 0, so the span must render unconditionally as "0 checks".
    getAnomalyStats.mockResolvedValue({
      checks: {},
      fires: {},
      falsePositives: {},
      falseNegatives: { stale_agent: 3 },
    });

    await mount();

    const row = container.querySelector('.stats-row:not(.muted)') as HTMLElement;
    expect(row).not.toBeNull();

    const checks = row.querySelector('.stats-checks') as HTMLElement;
    expect(checks).not.toBeNull();
    expect(checks.textContent).toContain('0 checks');
  });
});
