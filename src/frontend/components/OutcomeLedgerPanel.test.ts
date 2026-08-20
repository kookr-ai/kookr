// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OutcomeLedgerPanel } from './OutcomeLedgerPanel.js';

let root: Root | null;
let container: HTMLDivElement;

function fetchResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'outcome-ledger.v1',
    generatedAt: '2026-05-21T12:00:00.000Z',
    window: {
      value: '7d',
      start: '2026-05-14T12:00:00.000Z',
      end: '2026-05-21T12:00:00.000Z',
    },
    readiness: 'blocked',
    summary: {
      taskCount: 7,
      terminalTaskCount: 4,
      completedTaskCount: 2,
      cancelledTaskCount: 1,
      terminatedTaskCount: 1,
      activeTaskCount: 0,
      completionRate: 0.5,
      prTaskCount: 3,
      verifiedTaskCount: 1,
      thumbsUp: 1,
      thumbsDown: 1,
      feedbackCoverage: 0.5,
      thumbsUpRate: 0.5,
      totalKnownCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    },
    quality: {
      costKnownTasks: 1,
      zeroCostTasks: 1,
      missingCostTasks: 3,
      costCoverage: 0.25,
      durationKnownTasks: 4,
      durationCoverage: 1,
      digestKnownCompletedTasks: 1,
      digestCoverage: 0.5,
      verificationKnownCompletedTasks: 1,
      verificationCoverage: 0.5,
      interventionKnownTasks: 4,
      interventionCoverage: 1,
      invalidTimestampTasks: 0,
      noSessionTasks: 0,
    },
    byAgent: [{
      agentType: 'claude-code',
      taskCount: 8,
      completedTaskCount: 6,
      terminalTaskCount: 8,
      completionRate: 0.75,
      totalKnownCostUsd: 4.2,
      costCoverage: 0.5,
      medianDurationMs: 120_000,
      p95DurationMs: 600_000,
      thumbsUpRate: 0.8,
    }, {
      agentType: 'codex-cli',
      taskCount: 2,
      completedTaskCount: 2,
      terminalTaskCount: 2,
      completionRate: 1,
      totalKnownCostUsd: 0.5,
      costCoverage: 0.5,
      medianDurationMs: 30_000,
      p95DurationMs: 45_000,
      thumbsUpRate: 1,
    }],
    findings: [{
      kind: 'data_quality',
      severity: 'review',
      taskId: 'task-1',
      label: 'Cancelled after prompt',
      metric: 'cost',
      value: 0,
      message: 'A task with at least one session reports exactly $0 cost. Verify whether this is true zero work, cancelled work, or missing accounting.',
    }, {
      kind: 'data_quality',
      severity: 'review',
      taskId: 'task-2',
      label: 'Missing usage',
      metric: 'cost',
      value: null,
      message: 'Cost is unknown, not zero. Exclude this task from spend conclusions until token accounting is understood.',
    }],
    tasks: [{
      taskId: 'task-1',
      label: 'Cancelled after prompt',
      agentType: 'claude-code',
      status: 'cancelled',
      projectId: null,
      playbookId: null,
      startedAt: '2026-05-21T10:00:00.000Z',
      finishedAt: '2026-05-21T10:10:00.000Z',
      durationMs: 600_000,
      knownCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      interventionCount: 1,
      hasCompletionDigest: false,
      hasVerificationEvidence: false,
      prCount: 0,
      feedback: null,
      flags: ['zero_cost'],
    }],
    notes: ['Do not draw trend conclusions yet; data coverage or timestamp integrity is not strong enough.'],
    ...overrides,
  };
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(OutcomeLedgerPanel));
  });
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fetchResponse(response()))));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.restoreAllMocks();
});

describe('OutcomeLedgerPanel', () => {
  test('renders data-quality readiness and separates zero cost from unknown cost', async () => {
    const el = mount();

    await flush();

    expect(fetch).toHaveBeenCalledWith('/api/outcome-ledger?window=7d', expect.any(Object));
    expect(el.textContent).toContain('Outcome Scoreboard');
    expect(el.textContent).toContain('blocked');
    expect(el.textContent).toContain('3 missing cost');
    expect(el.textContent).toContain('1 zero-cost');
    // Distinct fixture values (prTaskCount=3, taskCount=7) uniquely pin the
    // value and both detail operands so a wrong-field render can't pass.
    const prMetric = Array.from(el.querySelectorAll('.outcome-metric')).find(
      (metric) => metric.querySelector('.outcome-metric-label')?.textContent === 'PRs',
    );
    expect(prMetric).toBeTruthy();
    expect(prMetric?.querySelector('strong')?.textContent).toBe('3');
    expect(prMetric?.querySelector('.outcome-metric-detail')?.textContent).toBe('3/7');
    expect(el.textContent).toContain('Cost is unknown, not zero.');
    expect(el.textContent).toContain('Cancelled after prompt');
    expect(el.querySelector('.outcome-findings-list')?.tagName).toBe('UL');
    expect(el.querySelector('.outcome-finding')?.tagName).toBe('LI');
  });

  test('renders a token-volume tile from the summary input/output totals', async () => {
    // Distinct values pin the combined value and both detail operands so a
    // wrong-field render (or swapped in/out) can't pass.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        fetchResponse(
          response({
            summary: {
              ...response().summary,
              totalInputTokens: 8200,
              totalOutputTokens: 1300,
            },
          }),
        ),
      ),
    );
    const el = mount();

    await flush();

    const tokenMetric = Array.from(el.querySelectorAll('.outcome-metric')).find(
      (metric) => metric.querySelector('.outcome-metric-label')?.textContent === 'tokens',
    );
    expect(tokenMetric).toBeTruthy();
    expect(tokenMetric?.querySelector('strong')?.textContent).toBe('9.5k');
    expect(tokenMetric?.querySelector('.outcome-metric-detail')?.textContent).toBe('8.2k in / 1.3k out');
  });

  test('compacts large token totals with the M / k formatter branches', async () => {
    // Exercises formatTokens's >=1M and >=10k rounding branches — the realistic
    // scoreboard case for aggregate token volume, distinct from the small-value
    // toFixed branch above.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        fetchResponse(
          response({
            summary: {
              ...response().summary,
              totalInputTokens: 1_200_000,
              totalOutputTokens: 350_000,
            },
          }),
        ),
      ),
    );
    const el = mount();

    await flush();

    const tokenMetric = Array.from(el.querySelectorAll('.outcome-metric')).find(
      (metric) => metric.querySelector('.outcome-metric-label')?.textContent === 'tokens',
    );
    expect(tokenMetric?.querySelector('strong')?.textContent).toBe('1.6M');
    expect(tokenMetric?.querySelector('.outcome-metric-detail')?.textContent).toBe('1.2M in / 350k out');
  });

  test('renders the cancelled/terminated/active disposition split from the summary', async () => {
    // Distinct counts uniquely pin each field so a wrong-field render can't pass.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        fetchResponse(
          response({
            summary: {
              ...response().summary,
              cancelledTaskCount: 4,
              terminatedTaskCount: 5,
              activeTaskCount: 6,
            },
          }),
        ),
      ),
    );
    const el = mount();

    await flush();

    const strip = el.querySelector('.outcome-disposition-strip');
    expect(strip).toBeTruthy();
    expect(strip?.textContent).toContain('4 cancelled');
    expect(strip?.textContent).toContain('5 terminated');
    expect(strip?.textContent).toContain('6 active');
  });

  test('renders one per-agent row and guards low-sample completion rates', async () => {
    const el = mount();

    await flush();

    const table = el.querySelector('.outcome-agent-table');
    expect(table).toBeTruthy();
    const dataRows = table!.querySelectorAll('tbody tr');
    expect(dataRows.length).toBe(2);

    // Well-sampled agent: headline completion rate shown.
    expect(el.textContent).toContain('Claude Code');
    expect(el.textContent).toContain('75%');
    expect(el.textContent).toContain('$4.20');

    // Low-sample agent (2 terminal tasks < threshold): rate withheld, raw count shown.
    expect(el.textContent).toContain('Codex CLI');
    const lowSample = el.querySelector('.outcome-agent-lowsample');
    expect(lowSample).toBeTruthy();
    expect(lowSample!.textContent).toContain('low sample');
    // The misleading 100% completion rate must NOT be rendered for the low-sample agent.
    expect(lowSample!.textContent).not.toContain('%');
    expect(lowSample!.textContent).toContain('2/2');

    // The thumbs-up rate is guarded too: the low-sample agent's 1-of-1 "100%"
    // feedback must NOT leak through the last column.
    const rows = table!.querySelectorAll('tbody tr');
    const claudeThumbs = rows[0].querySelectorAll('td')[4];
    const codexThumbs = rows[1].querySelectorAll('td')[4];
    expect(claudeThumbs.textContent).toContain('80%'); // well-sampled: rate shown
    expect(codexThumbs.textContent).not.toContain('%'); // low-sample: withheld
  });

  test('applies the low-sample guard exactly at the MIN_AGENT_SAMPLE boundary', async () => {
    // terminalTaskCount 5 is the first value that clears the guard (strict <);
    // 4 must still be guarded. Pins the threshold against an off-by-one flip.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(fetchResponse(response({
        byAgent: [{
          agentType: 'claude-code',
          taskCount: 5,
          completedTaskCount: 4,
          terminalTaskCount: 5,
          completionRate: 0.8,
          totalKnownCostUsd: 1,
          costCoverage: 1,
          medianDurationMs: 1000,
          p95DurationMs: 2000,
          thumbsUpRate: null,
        }, {
          agentType: 'codex-cli',
          taskCount: 4,
          completedTaskCount: 4,
          terminalTaskCount: 4,
          completionRate: 1,
          totalKnownCostUsd: 1,
          costCoverage: 1,
          medianDurationMs: 1000,
          p95DurationMs: 2000,
          thumbsUpRate: null,
        }],
      }))));
    const el = mount();

    await flush();

    const dataRows = el.querySelectorAll('.outcome-agent-table tbody tr');
    expect(dataRows.length).toBe(2);
    // Row 0 (5 terminal tasks) clears the guard: headline rate, no low-sample tag.
    expect(dataRows[0].querySelector('.outcome-agent-lowsample')).toBeNull();
    expect(dataRows[0].textContent).toContain('80%');
    // Row 1 (4 terminal tasks) is still guarded.
    expect(dataRows[1].querySelector('.outcome-agent-lowsample')).toBeTruthy();
    expect(dataRows[1].textContent).toContain('4/4');
  });

  test('omits the per-agent scoreboard when byAgent is empty', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(fetchResponse(response({ byAgent: [] }))));
    const el = mount();

    await flush();

    expect(el.querySelector('.outcome-agent-table')).toBeNull();
  });

  test('refetches when the selected window changes', async () => {
    const el = mount();
    await flush();

    const select = el.querySelector<HTMLSelectElement>('.outcome-window-select');
    expect(select).toBeTruthy();
    await act(async () => {
      select!.value = '30d';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(fetch).toHaveBeenCalledWith('/api/outcome-ledger?window=30d', expect.any(Object));
  });

  test('renders an error for invalid response payloads', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(fetchResponse({ schemaVersion: 'wrong' })));
    const el = mount();

    await flush();

    expect(el.textContent).toContain('Failed to load outcome ledger: invalid outcome ledger response');
  });
});
