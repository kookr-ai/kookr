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
    launchSourceMix: {
      total: 7,
      counts: { manual: 4, scheduled: 2, parent: 0, unknown: 1 },
      shares: { manual: 4 / 7, scheduled: 2 / 7, parent: 0, unknown: 1 / 7 },
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

function mount(props: React.ComponentProps<typeof OutcomeLedgerPanel> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(OutcomeLedgerPanel, props));
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

  test('a finding whose task is live opens that task by taskId, not label (issue #2783)', async () => {
    // Default fixture: task-1 ("Cancelled after prompt") and task-2 ("Missing
    // usage"). Only task-1 is live, so only its row is actionable, and it must
    // select by taskId — never the display label a historical row could share.
    const onOpenTask = vi.fn();
    const el = mount({ liveTaskIds: new Set(['task-1']), onOpenTask });

    await flush();

    const openButton = el.querySelector<HTMLButtonElement>('button.outcome-finding-open');
    expect(openButton).toBeTruthy();
    // Accessible name so keyboard/screen-reader users know what activating does.
    expect(openButton?.getAttribute('aria-label')).toBe('Open task Cancelled after prompt');
    // Exactly one openable row — the live one — even though two findings render.
    expect(el.querySelectorAll('button.outcome-finding-open').length).toBe(1);

    act(() => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith('task-1');
  });

  test('a finding with no live task stays a readable, non-actionable label (issue #2783)', async () => {
    // task-2 is not in the live set, so its row must render as plain text with no
    // button to activate — readable, but never selecting the wrong task.
    const onOpenTask = vi.fn();
    const el = mount({ liveTaskIds: new Set(['task-1']), onOpenTask });

    await flush();

    const taskCells = Array.from(el.querySelectorAll('.outcome-finding-task'));
    const missingUsageCell = taskCells.find((cell) => cell.textContent === 'Missing usage');
    expect(missingUsageCell).toBeTruthy();
    expect(missingUsageCell?.tagName).toBe('SPAN');
    // The historical row still reads its label; it just isn't a button.
    expect(el.textContent).toContain('Missing usage');
  });

  test('without onOpenTask wiring, no finding is openable (issue #2783)', async () => {
    // Even if every task were live, the panel must not fabricate an affordance
    // when the host provides no selection handler.
    const el = mount({ liveTaskIds: new Set(['task-1', 'task-2']) });

    await flush();

    expect(el.querySelector('button.outcome-finding-open')).toBeNull();
    // Labels still render as plain, readable text.
    expect(el.textContent).toContain('Cancelled after prompt');
  });

  test('with a handler but no live-id set, no finding is openable (issue #2783)', async () => {
    // The documented default: with onOpenTask wired but liveTaskIds omitted, the
    // `liveTaskIds?.has(...) ?? false` branch treats every task as not-live, so
    // nothing is openable rather than everything.
    const onOpenTask = vi.fn();
    const el = mount({ onOpenTask });

    await flush();

    expect(el.querySelector('button.outcome-finding-open')).toBeNull();
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Cancelled after prompt');
  });

  test('renders the per-finding metric:value only when value is non-null', async () => {
    // Distinct metrics/values pin each formatting branch: a known numeric metric
    // (cost → $) with value 0, a known token metric (compact k-formatting), a
    // string value rendered verbatim, and a null value that must render no chip.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(fetchResponse(response({
        findings: [{
          kind: 'data_quality',
          severity: 'review',
          taskId: 'task-cost0',
          label: 'Zero cost row',
          metric: 'cost',
          value: 0,
          message: 'A task with at least one session reports exactly $0 cost.',
        }, {
          kind: 'token_extreme',
          severity: 'review',
          taskId: 'task-tokens',
          label: 'Token outlier',
          metric: 'totalTokens',
          value: 42_000,
          message: 'Token count is far outside the observed distribution.',
        }, {
          kind: 'duration_extreme',
          severity: 'review',
          taskId: 'task-duration',
          label: 'Duration outlier',
          metric: 'durationMs',
          value: 3_600_000,
          message: 'Duration is far outside the observed distribution.',
        }, {
          kind: 'data_quality',
          severity: 'review',
          taskId: 'task-digest',
          label: 'Missing digest row',
          metric: 'digest',
          value: 'missing',
          message: 'Completed task has no completion digest.',
        }, {
          kind: 'data_quality',
          severity: 'review',
          taskId: 'task-null',
          label: 'Unknown cost row',
          metric: 'cost',
          value: null,
          message: 'Cost is unknown, not zero.',
        }],
      }))));
    const el = mount();

    await flush();

    // visibleFindings caps the list at 5, so the fixture stays at 5 to keep
    // every row (including the null-value row) rendered.
    const rows = Array.from(el.querySelectorAll('.outcome-finding'));
    expect(rows.length).toBe(5);
    const measureOf = (row: Element) => row.querySelector('.outcome-finding-measure')?.textContent;
    // Known numeric metric formatted with units, value 0 still shows (0 != null).
    // formatCost renders sub-cent values with 4 decimals, so $0 → $0.0000.
    expect(measureOf(rows[0])).toBe('cost: $0.0000');
    // Token count uses the compact k-formatter, not a raw locale integer.
    expect(measureOf(rows[1])).toBe('tokens: 42k');
    // Duration routes through formatMs (h/m/s), not a raw millisecond integer.
    expect(measureOf(rows[2])).toBe('duration: 1h 0m');
    // String value rendered verbatim under a humanized metric label.
    expect(measureOf(rows[3])).toBe('digest: missing');
    // Null value renders no chip at all — the row is otherwise unchanged.
    expect(rows[4].querySelector('.outcome-finding-measure')).toBeNull();
    expect(rows[4].textContent).toContain('Cost is unknown, not zero.');
    // A separating space keeps screen readers from concatenating the message
    // into the chip (e.g. "…$0 cost.cost: $0.0000").
    expect(rows[0].querySelector('.outcome-finding-text')?.textContent)
      .toContain('cost. cost: $0.0000');
  });

  test('formats a finding metric with no unit formatter as a locale integer', async () => {
    // The `default` branch of formatFindingValue: interventionCount has no unit
    // formatter, so it renders via toLocaleString under its humanized label.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(fetchResponse(response({
        findings: [{
          kind: 'intervention_extreme',
          severity: 'review',
          taskId: 'task-interventions',
          label: 'Intervention outlier',
          metric: 'interventionCount',
          value: 1234,
          message: 'Intervention count is far outside the observed distribution.',
        }],
      }))));
    const el = mount();

    await flush();

    const measure = el.querySelector('.outcome-finding-measure')?.textContent;
    expect(measure).toBe(`interventions: ${(1234).toLocaleString()}`);
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

  test('breaks review flags down by finding category while keeping the total', async () => {
    // One finding of every kind (data_quality doubled) exercises the whole
    // FINDING_KIND_ORDER end to end: the breakdown must group by kind and emit
    // the full order (data quality → duration → cost → intervention → token)
    // regardless of the shuffled input order, while "review flags" still totals 6.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(fetchResponse(response({
        findings: [{
          kind: 'token_extreme', severity: 'review', taskId: 'task-1',
          label: 'Token outlier', metric: 'totalTokens', value: 42_000, message: 'Token outlier.',
        }, {
          kind: 'data_quality', severity: 'review', taskId: 'task-2',
          label: 'Zero cost', metric: 'cost', value: 0, message: 'Zero cost.',
        }, {
          kind: 'intervention_extreme', severity: 'review', taskId: 'task-3',
          label: 'Intervention outlier', metric: 'interventionCount', value: 40, message: 'Intervention outlier.',
        }, {
          kind: 'data_quality', severity: 'review', taskId: 'task-4',
          label: 'Missing usage', metric: 'cost', value: null, message: 'Unknown cost.',
        }, {
          kind: 'cost_extreme', severity: 'review', taskId: 'task-5',
          label: 'Cost outlier', metric: 'knownCostUsd', value: 12, message: 'Cost outlier.',
        }, {
          kind: 'duration_extreme', severity: 'review', taskId: 'task-6',
          label: 'Duration outlier', metric: 'durationMs', value: 3_600_000, message: 'Duration outlier.',
        }],
      }))));
    const el = mount();

    await flush();

    // Total review-flag metric remains visible and correct.
    const flagsMetric = Array.from(el.querySelectorAll('.outcome-metric')).find(
      (metric) => metric.querySelector('.outcome-metric-label')?.textContent === 'review flags',
    );
    expect(flagsMetric?.querySelector('strong')?.textContent).toBe('6');

    // Breakdown lists one item per present kind, in the full FINDING_KIND_ORDER.
    const items = Array.from(el.querySelectorAll('.outcome-finding-breakdown-item'));
    expect(items.map((item) => item.querySelector('.outcome-finding-breakdown-label')?.textContent))
      .toEqual(['data quality', 'duration', 'cost', 'intervention', 'token']);
    expect(items.map((item) => item.querySelector('.outcome-finding-breakdown-count')?.textContent))
      .toEqual(['2', '1', '1', '1', '1']);

    // Labeled so a reader knows the counts are findings, not unique tasks.
    const list = el.querySelector('.outcome-finding-breakdown-list');
    expect(list?.getAttribute('aria-label')).toContain('findings, not tasks');
  });

  test('renders unrecognized finding kinds under their raw slug after known kinds', async () => {
    // Defensive coverage for a future backend kind not yet in FINDING_KIND_ORDER:
    // two off-contract kinds must render under their raw slug, sort AFTER every
    // known kind (POSITIVE_INFINITY rank), and break ties alphabetically by label.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(fetchResponse(response({
        findings: [{
          // Cast through unknown: these kinds are intentionally off-contract.
          kind: 'future_kind_z', severity: 'review', taskId: 'task-z',
          label: 'Future Z', metric: 'x', value: 1, message: 'Future Z.',
        }, {
          kind: 'data_quality', severity: 'review', taskId: 'task-known',
          label: 'Known', metric: 'cost', value: 0, message: 'Known.',
        }, {
          kind: 'future_kind_a', severity: 'review', taskId: 'task-a',
          label: 'Future A', metric: 'x', value: 1, message: 'Future A.',
        }] as unknown,
      }))));
    const el = mount();

    await flush();

    const items = Array.from(el.querySelectorAll('.outcome-finding-breakdown-item'));
    // Known kind first; the two unknowns follow, ordered by their raw-slug label.
    expect(items.map((item) => item.querySelector('.outcome-finding-breakdown-label')?.textContent))
      .toEqual(['data quality', 'future_kind_a', 'future_kind_z']);
    expect(items.map((item) => item.querySelector('.outcome-finding-breakdown-count')?.textContent))
      .toEqual(['1', '1', '1']);
  });

  test('counts findings, not tasks, including beyond the visible-row cap', async () => {
    // One task (task-multi) produces three findings of distinct kinds, plus three
    // data_quality findings on separate tasks — six findings across four tasks.
    // The visible list caps at five rows, so the breakdown total (6) proves it
    // counts every finding, not the capped list and not the four unique tasks.
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(fetchResponse(response({
        findings: [{
          kind: 'duration_extreme', severity: 'review', taskId: 'task-multi',
          label: 'Slow task', metric: 'durationMs', value: 3_600_000, message: 'Duration outlier.',
        }, {
          kind: 'cost_extreme', severity: 'review', taskId: 'task-multi',
          label: 'Slow task', metric: 'knownCostUsd', value: 9, message: 'Cost outlier.',
        }, {
          kind: 'token_extreme', severity: 'review', taskId: 'task-multi',
          label: 'Slow task', metric: 'totalTokens', value: 88_000, message: 'Token outlier.',
        }, {
          kind: 'data_quality', severity: 'review', taskId: 'task-a',
          label: 'A', metric: 'cost', value: 0, message: 'Zero cost.',
        }, {
          kind: 'data_quality', severity: 'review', taskId: 'task-b',
          label: 'B', metric: 'cost', value: 0, message: 'Zero cost.',
        }, {
          kind: 'data_quality', severity: 'review', taskId: 'task-c',
          label: 'C', metric: 'cost', value: 0, message: 'Zero cost.',
        }],
      }))));
    const el = mount();

    await flush();

    // Visible finding rows are capped at five, but the total counts all six.
    expect(el.querySelectorAll('.outcome-finding').length).toBe(5);
    const flagsMetric = Array.from(el.querySelectorAll('.outcome-metric')).find(
      (metric) => metric.querySelector('.outcome-metric-label')?.textContent === 'review flags',
    );
    expect(flagsMetric?.querySelector('strong')?.textContent).toBe('6');

    const countOf = (label: string) =>
      Array.from(el.querySelectorAll('.outcome-finding-breakdown-item'))
        .find((item) => item.querySelector('.outcome-finding-breakdown-label')?.textContent === label)
        ?.querySelector('.outcome-finding-breakdown-count')?.textContent;
    // task-multi alone contributes three of the four kinds; data quality counts
    // three findings across three tasks — the total (6) exceeds the 4 tasks.
    expect(countOf('data quality')).toBe('3');
    expect(countOf('duration')).toBe('1');
    expect(countOf('cost')).toBe('1');
    expect(countOf('token')).toBe('1');
    const total = Array.from(el.querySelectorAll('.outcome-finding-breakdown-count'))
      .reduce((sum, node) => sum + Number(node.textContent), 0);
    expect(total).toBe(6);
  });

  test('omits the category breakdown and keeps the empty state when there are no findings', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(fetchResponse(response({ findings: [] }))));
    const el = mount();

    await flush();

    expect(el.querySelector('.outcome-finding-breakdown')).toBeNull();
    const flagsMetric = Array.from(el.querySelectorAll('.outcome-metric')).find(
      (metric) => metric.querySelector('.outcome-metric-label')?.textContent === 'review flags',
    );
    expect(flagsMetric?.querySelector('strong')?.textContent).toBe('0');
    expect(el.textContent).toContain('No data-quality findings in this window.');
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

  test('offers All projects, Unassigned, and tracked-project options with friendly labels', async () => {
    const el = mount({
      projects: [
        { id: 'kookr-ai/kookr', label: 'Kookr' },
        // No friendly label available → raw ID is the safe fallback.
        { id: 'legacy-repo', label: 'legacy-repo' },
      ],
    });
    await flush();

    const select = el.querySelector<HTMLSelectElement>('.outcome-project-select');
    expect(select).toBeTruthy();
    const optionText = Array.from(select!.options).map((o) => o.textContent);
    expect(optionText).toEqual(['All projects', 'Unassigned', 'Kookr', 'legacy-repo']);
    // Default fetch stays byte-for-byte backward compatible (no scope params).
    expect(fetch).toHaveBeenCalledWith('/api/outcome-ledger?window=7d', expect.any(Object));
  });

  test('refetches with an assigned scope when a tracked project is selected', async () => {
    const el = mount({ projects: [{ id: 'org/repo?x=1', label: 'Fancy' }] });
    await flush();

    const select = el.querySelector<HTMLSelectElement>('.outcome-project-select');
    await act(async () => {
      select!.value = 'assigned:org/repo?x=1';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    // The project ID is URL-encoded so its `?`/`=` round-trip as data, not query
    // structure.
    expect(fetch).toHaveBeenCalledWith(
      '/api/outcome-ledger?window=7d&projectScope=assigned&projectId=org%2Frepo%3Fx%3D1',
      expect.any(Object),
    );
  });

  test('refetches with the unassigned scope', async () => {
    const el = mount();
    await flush();

    const select = el.querySelector<HTMLSelectElement>('.outcome-project-select');
    await act(async () => {
      select!.value = 'unassigned';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(fetch).toHaveBeenCalledWith(
      '/api/outcome-ledger?window=7d&projectScope=unassigned',
      expect.any(Object),
    );
  });

  test('falls back to All projects when the selected project stops being tracked', async () => {
    const el = mount({ projects: [{ id: 'org/repo', label: 'Repo' }] });
    await flush();

    const select = () => el.querySelector<HTMLSelectElement>('.outcome-project-select')!;
    await act(async () => {
      select().value = 'assigned:org/repo';
      select().dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      '/api/outcome-ledger?window=7d&projectScope=assigned&projectId=org%2Frepo',
      expect.any(Object),
    );

    vi.mocked(fetch).mockClear();
    // The project disappears from the tracked list → panel reverts to all-projects.
    act(() => {
      root!.render(React.createElement(OutcomeLedgerPanel, { projects: [] }));
    });
    await flush();

    expect(select().value).toBe('all');
    expect(fetch).toHaveBeenCalledWith('/api/outcome-ledger?window=7d', expect.any(Object));
  });

  test('renders an error for invalid response payloads', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(fetchResponse({ schemaVersion: 'wrong' })));
    const el = mount();

    await flush();

    expect(el.textContent).toContain('Failed to load outcome ledger: invalid outcome ledger response');
  });

  test('rejects an otherwise-valid response that is missing the launch-source mix', async () => {
    // A response with the right schemaVersion but no launchSourceMix must fail
    // the type guard rather than reach the panel and throw on mix.counts.
    const { launchSourceMix: _dropped, ...withoutMix } = response();
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(fetchResponse(withoutMix)));
    const el = mount();

    await flush();

    expect(el.textContent).toContain('Failed to load outcome ledger: invalid outcome ledger response');
  });
});
