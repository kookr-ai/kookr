// @vitest-environment jsdom

import React from 'react';
import { describe, expect, test, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CostComparisonPanel, buildCostComparisonCsv } from './CostComparisonPanel.js';
import type { CostComparisonResponse, AggregateMetrics, PerPlaybookRow, PerTaskRow } from '../../shared/contracts/cost-comparison.js';
import { COST_COMPARISON_PREFS_KEY } from '../store/cost-comparison-prefs.js';

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();

function emptyAgg(agent: 'claude-code' | 'codex-cli', overrides: Partial<AggregateMetrics> = {}): AggregateMetrics {
  return {
    agent, taskCount: 0, pricedTaskCount: 0, totalCostUsd: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    medianDurationMs: 0, p95DurationMs: 0, maxDurationMs: 0,
    thumbsUpRate: null, thumbsCount: { up: 0, down: 0, none: 0 },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<CostComparisonResponse> = {}): CostComparisonResponse {
  return {
    scannedAt: '2026-05-08T12:00:00Z',
    scanDurationMs: 42,
    perPlaybook: [],
    aggregate: {},
    perTask: [],
    notes: [],
    ...overrides,
  };
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(CostComparisonPanel, { onClose }));
  });
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mockFetchSequential(responses: Array<{ body: unknown; status?: number }>) {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      const status = r.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(r.body),
      } as unknown as Response);
    }),
  );
}

beforeEach(() => {
  onClose.mockClear();
  // The panel now persists its window/agent filter in localStorage (issue #3283),
  // and jsdom's localStorage is shared across tests in this file — clear it so
  // each test starts from the panel defaults rather than a prior test's selection.
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe('CostComparisonPanel', () => {
  test('renders empty state when no tasks in window', async () => {
    mockFetchSequential([{ body: makeResponse() }]);
    const el = mount();
    await flush();
    expect(el.textContent).toContain('No tasks in this window');
  });

  test('renders the scan timestamp and duration meta line', async () => {
    mockFetchSequential([{ body: makeResponse({ scannedAt: '2026-05-08T12:30:45Z', scanDurationMs: 87 }) }]);
    const el = mount();
    await flush();
    expect(el.querySelector('.cost-comparison-meta')?.textContent).toMatch(/87 ms/);
  });

  test('renders per-playbook table when rows are present', async () => {
    const claude: AggregateMetrics = emptyAgg('claude-code', { taskCount: 8, pricedTaskCount: 6, totalCostUsd: 1.86 });
    const codex: AggregateMetrics = emptyAgg('codex-cli', { taskCount: 5, pricedTaskCount: 4, totalCostUsd: 1.92 });
    const row: PerPlaybookRow = {
      playbookId: 'pb-1', playbookName: 'oss-pr',
      perAgent: { 'claude-code': claude, 'codex-cli': codex },
    };
    mockFetchSequential([{ body: makeResponse({ perPlaybook: [row] }) }]);
    const el = mount();
    await flush();
    const cells = Array.from(el.querySelectorAll('.cost-per-playbook tbody td'))
      .map((td) => td.textContent?.trim());
    // claude avg = $1.86/6 = $0.31, codex avg = $1.92/4 = $0.48 → codex 1.55×
    expect(cells).toEqual(['oss-pr', '$0.31 avg n=6', '$0.48 avg n=4', 'Codex 1.55×', '— / —']);
  });

  test('renders coverage summary when present', async () => {
    mockFetchSequential([{
      body: makeResponse({
        coverage: {
          taskCount: 147,
          pricedTaskCount: 139,
          excludedTaskCount: 8,
          unboundCodexThreadCount: 46,
          abandonedCodexRolloutCount: 31,
          runningTaskCount: 2,
          liveData: true,
        },
      }),
    }]);
    const el = mount();
    await flush();
    expect(el.querySelector('.cost-coverage-summary')?.textContent).toContain('147 tasks');
    expect(el.querySelector('.cost-coverage-summary')?.textContent).toContain('139 priced');
    expect(el.querySelector('.cost-coverage-summary')?.textContent).toContain('2 live');
  });

  test('renders aggregate cards when both agents have tasks', async () => {
    const aggregate = {
      'claude-code': emptyAgg('claude-code', { taskCount: 18, pricedTaskCount: 18, totalCostUsd: 4.21, medianDurationMs: 720_000, inputTokens: 1_250_000, outputTokens: 84_000, cacheReadTokens: 512 }),
      'codex-cli':   emptyAgg('codex-cli',   { taskCount: 12, pricedTaskCount: 12, totalCostUsd: 6.83, medianDurationMs: 1_080_000, inputTokens: 2_000_000, outputTokens: 120_500, cacheReadTokens: 0 }),
    };
    mockFetchSequential([{ body: makeResponse({ aggregate }) }]);
    const el = mount();
    await flush();
    const cards = Array.from(el.querySelectorAll('.cost-aggregate-card')).map((card) => ({
      title: card.querySelector('h4')?.textContent?.trim(),
      stats: Array.from(card.querySelectorAll('.cost-stat'))
        .map((stat) => stat.textContent?.replace(/\s+/g, ' ').trim()),
    }));
    expect(cards).toEqual([
      {
        title: 'Claude',
        stats: ['tasks 18', 'total $4.21', 'in tok 1.3M', 'out tok 84.0k', 'cache rd 512', 'med dur 12m00s', 'p95 dur —', 'max dur —', '👍 rate —'],
      },
      {
        title: 'Codex',
        stats: ['tasks 12', 'total $6.83', 'in tok 2.0M', 'out tok 120.5k', 'cache rd 0', 'med dur 18m00s', 'p95 dur —', 'max dur —', '👍 rate —'],
      },
    ]);
  });

  test('the 👍 rate card shows the vote count (n) behind the percentage', async () => {
    const aggregate = {
      // Healthy sample: 7 up / 2 down → 78% (n=9).
      'claude-code': emptyAgg('claude-code', {
        taskCount: 9, pricedTaskCount: 9, totalCostUsd: 1,
        thumbsUpRate: 7 / 9, thumbsCount: { up: 7, down: 2, none: 0 },
      }),
      // Low sample: 1 up / 0 down → 100% but n=1, so the sample size is visible.
      'codex-cli': emptyAgg('codex-cli', {
        taskCount: 1, pricedTaskCount: 1, totalCostUsd: 1,
        thumbsUpRate: 1, thumbsCount: { up: 1, down: 0, none: 0 },
      }),
    };
    mockFetchSequential([{ body: makeResponse({ aggregate }) }]);
    const el = mount();
    await flush();
    const thumbStats = Array.from(el.querySelectorAll('.cost-aggregate-card'))
      .map((card) => Array.from(card.querySelectorAll('.cost-stat'))
        .map((s) => s.textContent?.replace(/\s+/g, ' ').trim())
        .find((t) => t?.startsWith('👍 rate')));
    expect(thumbStats).toEqual(['👍 rate 78% (n=9)', '👍 rate 100% (n=1)']);
  });

  test('the 👍 rate percentage is derived from the vote count, not a drifted thumbsUpRate', async () => {
    const aggregate = {
      // thumbsUpRate is deliberately inconsistent with thumbsCount (0.5 vs 7/9).
      // The card must render the percentage derived from up+down (78%), so the
      // percentage and the count can never disagree — issue #2712's invariant.
      'claude-code': emptyAgg('claude-code', {
        taskCount: 9, pricedTaskCount: 9, totalCostUsd: 1,
        thumbsUpRate: 0.5, thumbsCount: { up: 7, down: 2, none: 0 },
      }),
    };
    mockFetchSequential([{ body: makeResponse({ aggregate }) }]);
    const el = mount();
    await flush();
    const thumbStat = Array.from(el.querySelector('.cost-aggregate-card')!.querySelectorAll('.cost-stat'))
      .map((s) => s.textContent?.replace(/\s+/g, ' ').trim())
      .find((t) => t?.startsWith('👍 rate'));
    expect(thumbStat).toBe('👍 rate 78% (n=9)');
  });

  test('the 👍 rate card implies no rate when there are zero feedback votes', async () => {
    const aggregate = {
      // thumbsUpRate null and n=0 → render "—", never a misleading percentage.
      'claude-code': emptyAgg('claude-code', {
        taskCount: 4, pricedTaskCount: 4, totalCostUsd: 1,
        thumbsUpRate: null, thumbsCount: { up: 0, down: 0, none: 4 },
      }),
    };
    mockFetchSequential([{ body: makeResponse({ aggregate }) }]);
    const el = mount();
    await flush();
    const thumbStat = Array.from(el.querySelector('.cost-aggregate-card')!.querySelectorAll('.cost-stat'))
      .map((s) => s.textContent?.replace(/\s+/g, ' ').trim())
      .find((t) => t?.startsWith('👍 rate'));
    expect(thumbStat).toBe('👍 rate —');
  });

  test('distinguishes otherwise identical tasks by name and renders names as plain text', async () => {
    mockFetchSequential([{
      body: makeResponse({ perTask: [
        taskRow({ taskId: 'login', taskName: 'Fix <b>login</b>' }),
        taskRow({ taskId: 'logout', taskName: 'Fix logout' }),
      ] }),
    }]);
    const el = mount();
    await flush();
    const table = el.querySelector('.cost-per-task-table')!;
    expect(Array.from(table.querySelectorAll('th'), cell => cell.textContent))
      .toEqual(['Task', 'Started', 'Agent', 'Model', 'Playbook', 'DurDuration', 'Cost', '👍Feedback', 'Quality']);
    const rows = Array.from(table.querySelectorAll('tbody tr'), row =>
      Array.from(row.querySelectorAll('td'), cell => cell.textContent));
    expect(rows.map(row => row[0])).toEqual(['Fix <b>login</b>', 'Fix logout']);
    expect(rows[0].slice(1)).toEqual(rows[1].slice(1));
    expect(table.querySelector('b')).toBeNull();
  });

  test('falls back to IDs for unnamed and legacy rows, including incomplete costs', async () => {
    const { taskName: _omitted, ...legacyRow } = taskRow({ taskId: 'legacy-task', dataQuality: 'codex-parse-error' });
    mockFetchSequential([{
      body: { ...makeResponse(), perTask: [
        taskRow({ taskId: 'unnamed-task', taskName: null, dataQuality: 'missing-usage', estimatedCostUsd: null }),
        { ...legacyRow, estimatedCostUsd: null, prompt: 'Never display this prompt' },
      ] },
    }]);
    const el = mount();
    await flush();
    expect(Array.from(el.querySelectorAll('.cost-per-task-table tbody tr'), row => row.querySelector('td')?.textContent))
      .toEqual(['unnamed-task', 'legacy-task']);
    expect(el.textContent).not.toContain('Never display this prompt');
  });

  function perTaskNames(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll('.cost-per-task-table tbody tr'), (row) =>
      row.querySelector('td')?.textContent ?? '',
    );
  }

  function perTaskSortButton(el: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(el.querySelectorAll('.cost-per-task-table thead button'))
      .find((btn) => (btn.textContent ?? '').includes(label));
    if (!button) throw new Error(`sort button "${label}" not found`);
    return button as HTMLButtonElement;
  }

  function perTaskAriaSort(el: HTMLElement, label: string): string | null {
    const th = Array.from(el.querySelectorAll('.cost-per-task-table thead th'))
      .find((header) => (header.textContent ?? '').includes(label));
    return th?.getAttribute('aria-sort') ?? null;
  }

  test('clicking Cost reorders per-task rows by cost and toggles desc/asc (issue #3299)', async () => {
    mockFetchSequential([{
      body: makeResponse({
        perTask: [
          // startedAt is deliberately inverse of cost so a Cost sort cannot
          // pass by accidentally sorting on start time.
          taskRow({ taskId: 'cheap', taskName: 'cheap', estimatedCostUsd: 0.10, durationMs: 90_000, startedAt: '2026-05-08T12:00:00Z' }),
          taskRow({ taskId: 'pricey', taskName: 'pricey', estimatedCostUsd: 2.50, durationMs: 30_000, startedAt: '2026-05-08T10:00:00Z' }),
          taskRow({ taskId: 'mid', taskName: 'mid', estimatedCostUsd: 0.80, durationMs: 60_000, startedAt: '2026-05-08T11:00:00Z' }),
        ],
      }),
    }]);
    const el = mount();
    await flush();
    expect(perTaskNames(el)).toEqual(['cheap', 'pricey', 'mid']);
    expect(perTaskAriaSort(el, 'Cost')).toBe('none');
    expect(perTaskAriaSort(el, 'Dur')).toBe('none');
    expect(perTaskAriaSort(el, 'Started')).toBe('none');

    act(() => perTaskSortButton(el, 'Cost').click());
    expect(perTaskNames(el)).toEqual(['pricey', 'mid', 'cheap']);
    expect(perTaskAriaSort(el, 'Cost')).toBe('descending');
    expect(perTaskAriaSort(el, 'Dur')).toBe('none');

    act(() => perTaskSortButton(el, 'Cost').click());
    expect(perTaskNames(el)).toEqual(['cheap', 'mid', 'pricey']);
    expect(perTaskAriaSort(el, 'Cost')).toBe('ascending');
  });

  test('clicking Dur and Started sort those columns, leaving equal keys in server order', async () => {
    mockFetchSequential([{
      body: makeResponse({
        perTask: [
          taskRow({ taskId: 'a', taskName: 'alpha', estimatedCostUsd: 1, durationMs: 90_000, startedAt: '2026-05-08T10:00:00Z' }),
          taskRow({ taskId: 'b', taskName: 'bravo', estimatedCostUsd: 1, durationMs: 30_000, startedAt: '2026-05-08T12:00:00Z' }),
          taskRow({ taskId: 'c', taskName: 'charlie', estimatedCostUsd: 1, durationMs: 60_000, startedAt: '2026-05-08T11:00:00Z' }),
        ],
      }),
    }]);
    const el = mount();
    await flush();

    act(() => perTaskSortButton(el, 'Dur').click());
    expect(perTaskNames(el)).toEqual(['alpha', 'charlie', 'bravo']);
    expect(perTaskAriaSort(el, 'Dur')).toBe('descending');
    expect(perTaskAriaSort(el, 'Cost')).toBe('none');

    act(() => perTaskSortButton(el, 'Started').click());
    expect(perTaskNames(el)).toEqual(['bravo', 'charlie', 'alpha']);
    expect(perTaskAriaSort(el, 'Started')).toBe('descending');
    expect(perTaskAriaSort(el, 'Dur')).toBe('none');

    act(() => perTaskSortButton(el, 'Started').click());
    expect(perTaskNames(el)).toEqual(['alpha', 'charlie', 'bravo']);
    expect(perTaskAriaSort(el, 'Started')).toBe('ascending');

    // Equal costs keep the original relative order (stable sort).
    act(() => perTaskSortButton(el, 'Cost').click());
    expect(perTaskNames(el)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  test('unpriced costs and missing durations sort last in either direction', async () => {
    mockFetchSequential([{
      body: makeResponse({
        perTask: [
          taskRow({ taskId: 'n', taskName: 'none', estimatedCostUsd: null, durationMs: null, startedAt: 'not-a-date' }),
          taskRow({ taskId: 'hi', taskName: 'high', estimatedCostUsd: 2, durationMs: 80_000, startedAt: '2026-05-08T12:00:00Z' }),
          taskRow({ taskId: 'lo', taskName: 'low', estimatedCostUsd: 0, durationMs: 20_000, startedAt: '2026-05-08T10:00:00Z' }),
        ],
      }),
    }]);
    const el = mount();
    await flush();

    act(() => perTaskSortButton(el, 'Cost').click());
    expect(perTaskNames(el)).toEqual(['high', 'low', 'none']);
    act(() => perTaskSortButton(el, 'Cost').click());
    expect(perTaskNames(el)).toEqual(['low', 'high', 'none']);

    act(() => perTaskSortButton(el, 'Dur').click());
    expect(perTaskNames(el)).toEqual(['high', 'low', 'none']);
    act(() => perTaskSortButton(el, 'Dur').click());
    expect(perTaskNames(el)).toEqual(['low', 'high', 'none']);

    act(() => perTaskSortButton(el, 'Started').click());
    expect(perTaskNames(el)).toEqual(['high', 'low', 'none']);
    act(() => perTaskSortButton(el, 'Started').click());
    expect(perTaskNames(el)).toEqual(['low', 'high', 'none']);
  });

  test('CSV export stays in server order after the table is sorted (issue #3299)', async () => {
    mockFetchSequential([{
      body: makeResponse({
        perTask: [
          taskRow({ taskId: 'a', taskName: 'alpha', estimatedCostUsd: 0.10 }),
          taskRow({ taskId: 'b', taskName: 'bravo', estimatedCostUsd: 2.50 }),
        ],
      }),
    }]);
    const el = mount();
    await flush();
    act(() => perTaskSortButton(el, 'Cost').click());
    expect(perTaskNames(el)).toEqual(['bravo', 'alpha']);

    const { lines } = await clickExportAndRead(el);
    const perTaskIdx = lines.indexOf('Per task');
    expect(lines[perTaskIdx + 2]).toContain('alpha,a,');
    expect(lines[perTaskIdx + 3]).toContain('bravo,b,');
  });

  test('renders the "—" cost cell with a dataQuality tooltip when cost is null', async () => {
    const response = makeResponse({
      perTask: [{
        taskId: 't1', taskName: 'Find rollout', agent: 'codex-cli', model: null, playbookId: null,
        startedAt: '2026-05-08T11:00:00Z', status: 'completed', isTerminal: true, durationMs: 60_000,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, thumb: null, dataQuality: 'codex-rollout-not-found',
      }],
    });
    mockFetchSequential([{ body: response }]);
    const el = mount();
    await flush();
    // The cost cell is the only td whose title matches the rollout-not-found tooltip.
    const costCell = Array.from(el.querySelectorAll('.cost-per-task-table td'))
      .find(td => (td.getAttribute('title') ?? '').includes('No Codex rollout file matched'));
    expect(costCell).toBeDefined();
    // The visible glyph is "—" (in an aria-hidden span); a sibling sr-only span carries the
    // tooltip text for screen readers. Check the visible glyph specifically.
    expect(costCell?.querySelector('[aria-hidden]')?.textContent).toBe('—');
    expect(el.querySelector('.cost-quality-badge')?.textContent).toBe('missing rollout');
    expect(el.querySelector('.cost-per-task-table tbody td')?.textContent).toBe('Find rollout');
  });

  test('renders running duration and missing-usage badge', async () => {
    const response = makeResponse({
      perTask: [{
        taskId: 't1', taskName: 'Track live usage', agent: 'claude-code', model: null, playbookId: null,
        startedAt: '2026-05-08T11:00:00Z', status: 'inProgress', isTerminal: false, durationMs: null,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, thumb: null, dataQuality: 'missing-usage',
      }],
    });
    mockFetchSequential([{ body: response }]);
    const el = mount();
    await flush();
    expect(el.querySelector('.cost-per-task-table')?.textContent).toContain('running');
    expect(el.querySelector('.cost-quality-badge')?.textContent).toBe('missing usage');
    expect(el.querySelector('.cost-quality-badge')?.getAttribute('aria-label')).toContain('Usage not available');
    expect(el.querySelector('.cost-per-task-table tbody td')?.textContent).toBe('Track live usage');
  });

  test('renders unbound Codex as a coverage caveat, not an aggregate peer card', async () => {
    mockFetchSequential([{
      body: makeResponse({
        aggregate: {
          'claude-code': emptyAgg('claude-code', { taskCount: 1, pricedTaskCount: 1 }),
          'codex-cli': emptyAgg('codex-cli', { taskCount: 1, pricedTaskCount: 1 }),
        },
        unboundCodex: {
          threadCount: 46,
          totalCostUsd: 726.28,
          totalInputTokens: 28_800_000,
          totalOutputTokens: 2_500_000,
          totalCachedInputTokens: 1_014_100_000,
          dataQualityCounts: { complete: 43, 'unknown-pricing': 2, 'codex-no-tokens': 1, 'codex-parse-error': 0 },
        },
      }),
    }]);
    const el = mount();
    await flush();
    const caveat = el.querySelector('.cost-coverage-caveat')?.textContent ?? '';
    expect(caveat).toContain('Unbound Codex');
    expect(caveat).toContain('46 threads');
    expect(caveat).toContain('$726.28 priced');
    expect(caveat).toContain('28.8M input');
    expect(caveat).toContain('2.5M output');
    expect(caveat).toContain('1014.1M cached input');
    expect(caveat).toContain('2 unknown-pricing');
    expect(caveat).toContain('1 no-tokens');
    expect(Array.from(el.querySelectorAll('.cost-aggregate-card h4')).map(h => h.textContent?.trim())).toEqual(['Claude', 'Codex']);
  });

  test('renders banner stack: top 3 inline + "n more notes" expander', async () => {
    const notes = [
      { message: 'note-1' }, { message: 'note-2' }, { message: 'note-3' },
      { message: 'note-4' }, { message: 'note-5' },
    ];
    mockFetchSequential([{ body: makeResponse({ notes }) }]);
    const el = mount();
    await flush();
    const visible = Array.from(el.querySelectorAll('.cost-note')).map(n => n.textContent);
    expect(visible).toEqual(['note-1', 'note-2', 'note-3']);
    const expander = el.querySelector('.cost-notes-expander');
    expect(expander?.textContent).toMatch(/2 more notes/);
  });

  test('renders error message on HTTP failure', async () => {
    mockFetchSequential([{ body: { error: 'oops' }, status: 500 }]);
    const el = mount();
    await flush();
    expect(el.querySelector('.cost-comparison-error')?.textContent).toMatch(/HTTP 500/);
  });

  test('changing time-window triggers a new fetch', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(makeResponse()),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);
    const el = mount();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0][0] as string)).toContain('window=7d');

    const select = el.querySelector('.cost-window-select') as HTMLSelectElement;
    act(() => {
      select.value = '30d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(fetchSpy.mock.calls.some(c => (c[0] as string).includes('window=30d'))).toBe(true);
  });

  test('aborts stale cost-comparison requests when filters change', async () => {
    const signals: AbortSignal[] = [];
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetchSpy);
    const el = mount();
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    const select = el.querySelector('.cost-window-select') as HTMLSelectElement;
    act(() => {
      select.value = '30d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(signals[0]?.aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  test('restores a persisted window and agent filter on mount (issue #3283)', async () => {
    localStorage.setItem(
      COST_COMPARISON_PREFS_KEY,
      JSON.stringify({ window: '24h', agent: 'claude-code' }),
    );
    const fetchSpy = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(makeResponse()),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);

    const el = mount();
    await flush();

    expect(el.querySelector<HTMLSelectElement>('.cost-window-select')!.value).toBe('24h');
    const pressed = Array.from(el.querySelectorAll<HTMLButtonElement>('.cost-agent-chip'))
      .find((chip) => chip.getAttribute('aria-pressed') === 'true');
    expect(pressed?.textContent).toBe('Claude');
    expect(fetchSpy.mock.calls[0][0] as string).toContain('window=24h');
    expect(fetchSpy.mock.calls[0][0] as string).toContain('agent=claude-code');
  });

  test('persists the selected window and agent filter across a fresh mount (issue #3283)', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(makeResponse()),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);
    const first = mount();
    await flush();

    const select = first.querySelector<HTMLSelectElement>('.cost-window-select')!;
    act(() => {
      select.value = '24h';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const claudeChip = Array.from(first.querySelectorAll('.cost-agent-chip'))
      .find((chip) => chip.textContent === 'Claude') as HTMLButtonElement;
    act(() => claudeChip.click());
    await flush();

    act(() => root!.unmount());
    const second = mount();
    await flush();

    expect(second.querySelector<HTMLSelectElement>('.cost-window-select')!.value).toBe('24h');
    const pressed = Array.from(second.querySelectorAll<HTMLButtonElement>('.cost-agent-chip'))
      .find((chip) => chip.getAttribute('aria-pressed') === 'true');
    expect(pressed?.textContent).toBe('Claude');
    expect(JSON.parse(localStorage.getItem(COST_COMPARISON_PREFS_KEY)!)).toEqual({
      window: '24h',
      agent: 'claude-code',
    });
  });

  test('changing the window keeps a previously selected agent filter (issue #3283)', async () => {
    mockFetchSequential([{ body: makeResponse() }]);
    const el = mount();
    await flush();

    const claudeChip = Array.from(el.querySelectorAll('.cost-agent-chip'))
      .find((chip) => chip.textContent === 'Claude') as HTMLButtonElement;
    act(() => claudeChip.click());
    await flush();

    const select = el.querySelector<HTMLSelectElement>('.cost-window-select')!;
    act(() => {
      select.value = '30d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(JSON.parse(localStorage.getItem(COST_COMPARISON_PREFS_KEY)!)).toEqual({
      window: '30d',
      agent: 'claude-code',
    });

    act(() => root!.unmount());
    const second = mount();
    await flush();
    expect(second.querySelector<HTMLSelectElement>('.cost-window-select')!.value).toBe('30d');
    const pressed = Array.from(second.querySelectorAll<HTMLButtonElement>('.cost-agent-chip'))
      .find((chip) => chip.getAttribute('aria-pressed') === 'true');
    expect(pressed?.textContent).toBe('Claude');
  });

  test('does not persist the free-text search box (issue #3283)', async () => {
    mockFetchSequential([{ body: makeResponse() }]);
    const first = mount();
    await flush();

    const search = first.querySelector<HTMLInputElement>('.cost-search')!;
    act(() => {
      search.value = 'login';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const select = first.querySelector<HTMLSelectElement>('.cost-window-select')!;
    act(() => {
      select.value = '30d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(JSON.parse(localStorage.getItem(COST_COMPARISON_PREFS_KEY)!)).toEqual({
      window: '30d',
      agent: 'all',
    });
    expect(localStorage.getItem(COST_COMPARISON_PREFS_KEY)).not.toContain('login');

    act(() => root!.unmount());
    const second = mount();
    await flush();
    expect(second.querySelector<HTMLInputElement>('.cost-search')!.value).toBe('');
    expect(second.querySelector<HTMLSelectElement>('.cost-window-select')!.value).toBe('30d');
  });

  test('falls back to defaults for malformed stored JSON without crashing (issue #3283)', async () => {
    localStorage.setItem(COST_COMPARISON_PREFS_KEY, 'not-json{');
    const fetchSpy = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(makeResponse()),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);

    const el = mount();
    await flush();

    expect(el.querySelector<HTMLSelectElement>('.cost-window-select')!.value).toBe('7d');
    const pressed = Array.from(el.querySelectorAll<HTMLButtonElement>('.cost-agent-chip'))
      .find((chip) => chip.getAttribute('aria-pressed') === 'true');
    expect(pressed?.textContent).toBe('All');
    expect(fetchSpy.mock.calls[0][0] as string).toContain('window=7d');
    expect(fetchSpy.mock.calls[0][0] as string).not.toContain('agent=');
  });

  test('falls back to defaults for a future-format stored window without crashing (issue #3283)', async () => {
    localStorage.setItem(
      COST_COMPARISON_PREFS_KEY,
      JSON.stringify({ v: 2, window: '90d', agent: 'grok-build', sort: 'cost' }),
    );
    mockFetchSequential([{ body: makeResponse() }]);

    const el = mount();
    await flush();

    expect(el.querySelector<HTMLSelectElement>('.cost-window-select')!.value).toBe('7d');
    const pressed = Array.from(el.querySelectorAll<HTMLButtonElement>('.cost-agent-chip'))
      .find((chip) => chip.getAttribute('aria-pressed') === 'true');
    expect(pressed?.textContent).toBe('All');
  });

  test('selecting an agent chip narrows the fetch', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(makeResponse()),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);
    const el = mount();
    await flush();
    // Click the "Codex" chip.
    const chip = Array.from(el.querySelectorAll('.cost-agent-chip')).find(b => b.textContent === 'Codex') as HTMLButtonElement;
    act(() => chip.click());
    await flush();
    expect(fetchSpy.mock.calls.some(c => (c[0] as string).includes('agent=codex-cli'))).toBe(true);
  });

  function sendTab(shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  function focusablesInDialog(el: HTMLElement): HTMLElement[] {
    const dialog = el.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return [];
    const selector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');
    return Array.from(dialog.querySelectorAll<HTMLElement>(selector));
  }

  test('initial focus lands on the close button', async () => {
    mockFetchSequential([{ body: makeResponse() }]);
    const el = mount();
    await flush();
    const close = el.querySelector<HTMLButtonElement>('button[aria-label="Close cost comparison"]');
    expect(close).toBeTruthy();
    expect(document.activeElement).toBe(close);
  });

  test('Escape still closes the panel', async () => {
    mockFetchSequential([{ body: makeResponse() }]);
    mount();
    await flush();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  test('Tab from the last focusable wraps to the first, and Shift+Tab wraps back', async () => {
    mockFetchSequential([{ body: makeResponse() }]);
    const el = mount();
    await flush();

    const focusables = focusablesInDialog(el);
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(first);
    expect(forwardWrap.defaultPrevented).toBe(true);

    first.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(last);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('pulls focus back inside when Tab starts outside the dialog', async () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Outside';
    document.body.appendChild(outside);

    mockFetchSequential([{ body: makeResponse() }]);
    const el = mount();
    await flush();

    outside.focus();
    expect(document.activeElement).toBe(outside);

    const escapedFocus = sendTab();
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(escapedFocus.defaultPrevented).toBe(true);

    outside.remove();
  });

  // ---------- CSV export (#2422) ------------------------------------------------

  function taskRow(overrides: Partial<PerTaskRow> = {}): PerTaskRow {
    return {
      taskId: 't1', taskName: 'Fix login', agent: 'claude-code', model: 'sonnet', playbookId: 'oss-pr',
      startedAt: '2026-05-08T11:00:00Z', status: 'completed', isTerminal: true, durationMs: 65_000,
      inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0,
      estimatedCostUsd: 0.1234, thumb: 'up', dataQuality: 'complete',
      ...overrides,
    };
  }

  /**
   * Click Export CSV and capture the serialised blob. Stubs URL.createObjectURL
   * (unimplemented in jsdom) so the download path runs without a real
   * navigation. `csv`/`lines` come from `blob.text()`, which per spec strips the
   * leading BOM; assert the BOM via `bytes` (raw, un-decoded).
   */
  async function clickExportAndRead(
    el: HTMLElement,
  ): Promise<{ csv: string; lines: string[]; bytes: Uint8Array; filename: string }> {
    const blobs: Blob[] = [];
    let filename = '';
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:mock'; }) as typeof URL.createObjectURL;
    // Leave a no-op revoke in place (never restore to a possibly-undefined
    // original): the download path revokes on a deferred timer that may fire
    // after this helper returns.
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download;
    });
    const btn = el.querySelector('.cost-export-btn') as HTMLButtonElement;
    act(() => btn.click());
    clickSpy.mockRestore();
    URL.createObjectURL = origCreate;
    const blob = blobs[0];
    const csv = blob ? await blob.text() : '';
    const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
    return { csv, lines: csv.split('\r\n'), bytes, filename };
  }

  test('Export CSV button is disabled before data loads', async () => {
    // A fetch that never resolves keeps the panel in the pre-data state.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const el = mount();
    await flush();
    const btn = el.querySelector('.cost-export-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  test('Export CSV button is enabled once data loads', async () => {
    mockFetchSequential([{ body: makeResponse({ perTask: [taskRow()] }) }]);
    const el = mount();
    await flush();
    expect((el.querySelector('.cost-export-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  test('Export CSV downloads visible per-playbook and per-task rows', async () => {
    const claude = emptyAgg('claude-code', { taskCount: 8, pricedTaskCount: 6, totalCostUsd: 1.86 });
    const codex = emptyAgg('codex-cli', { taskCount: 5, pricedTaskCount: 4, totalCostUsd: 1.92 });
    const playbook: PerPlaybookRow = {
      playbookId: 'pb-1', playbookName: 'oss-pr',
      perAgent: { 'claude-code': claude, 'codex-cli': codex },
    };
    mockFetchSequential([{ body: makeResponse({ perPlaybook: [playbook], perTask: [taskRow()] }) }]);
    const el = mount();
    await flush();

    const { bytes, lines, filename } = await clickExportAndRead(el);
    // Excel-safe: the file's raw bytes lead with a UTF-8 BOM (EF BB BF).
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xEF, 0xBB, 0xBF]);
    // Full-line assertions (not substrings) so every column is checked, including
    // the trailing thumbs-ratio column that a substring check would silently skip.
    expect(lines).toContain('Per playbook');
    expect(lines).toContain('Playbook,Claude avg (USD),Claude n,Codex avg (USD),Codex n,Cost ratio,Thumbs-up ratio (Claude / Codex)');
    // claude avg = 1.86/6 = 0.3100, codex avg = 1.92/4 = 0.4800 → Codex 1.55×; no feedback → — / —
    expect(lines).toContain('oss-pr,0.3100,6,0.4800,4,Codex 1.55×,— / —');
    expect(lines).toContain('Per task');
    expect(lines).toContain('Task,Task ID,Started,Agent,Model,Playbook,Duration,Cost (USD),Feedback,Quality');
    // duration 65_000ms → 1m05s, cost 0.1234, thumb up, complete → priced
    expect(lines).toContain('Fix login,t1,2026-05-08T11:00:00.000Z,Claude,sonnet,oss-pr,1m05s,0.1234,up,priced');
    expect(filename).toMatch(/^kookr-cost-comparison-7d-all-.*\.csv$/);
  });

  test('exports header-only sections when the loaded window has no rows', async () => {
    mockFetchSequential([{ body: makeResponse() }]);
    const el = mount();
    await flush();
    // Button is enabled on any loaded payload, including an empty one.
    expect((el.querySelector('.cost-export-btn') as HTMLButtonElement).disabled).toBe(false);

    const { lines } = await clickExportAndRead(el);
    // Section labels + column headers present; no data rows, no crash.
    expect(lines).toContain('Per playbook');
    expect(lines.slice(lines.indexOf('Per task'))).toEqual([
      'Per task',
      'Task,Task ID,Started,Agent,Model,Playbook,Duration,Cost (USD),Feedback,Quality',
      '',
    ]);
  });

  test('exports empty cells for null cost / model / playbook', async () => {
    const csv = buildCostComparisonCsv(
      makeResponse({
        perTask: [taskRow({
          model: null, playbookId: null, estimatedCostUsd: null,
          thumb: null, dataQuality: 'missing-usage',
        })],
      }),
      { window: '7d', agent: 'all', search: '' },
    );
    // ISO date, Claude, empty model, empty playbook, 1m05s, empty cost, empty feedback, quality label.
    expect(csv).toContain('2026-05-08T11:00:00.000Z,Claude,,,1m05s,,,missing usage');
  });

  test('exports the ID as Task for unnamed and legacy rows', async () => {
    const { taskName: _omitted, ...legacyRow } = taskRow({ taskId: 'legacy-task' });
    mockFetchSequential([{
      body: { ...makeResponse(), perTask: [taskRow({ taskId: 'unnamed-task', taskName: null }), legacyRow] },
    }]);
    const el = mount();
    await flush();
    const { lines } = await clickExportAndRead(el);
    expect(lines).toContain('unnamed-task,unnamed-task,2026-05-08T11:00:00.000Z,Claude,sonnet,oss-pr,1m05s,0.1234,up,priced');
    expect(lines).toContain('legacy-task,legacy-task,2026-05-08T11:00:00.000Z,Claude,sonnet,oss-pr,1m05s,0.1234,up,priced');
  });

  test('exported preamble follows the active window and agent filter', async () => {
    mockFetchSequential([
      { body: makeResponse({ perTask: [taskRow({ taskId: 'a', playbookId: '7d-row' })] }) },
      { body: makeResponse({ perTask: [taskRow({ taskId: 'b', playbookId: 'codex-row' })] }) },
    ]);
    const el = mount();
    await flush();

    const first = await clickExportAndRead(el);
    expect(first.lines).toContain('Window,7d');
    expect(first.lines).toContain('Agent filter,all');
    expect(first.csv).toContain('7d-row');
    expect(first.csv).not.toContain('codex-row');

    // Narrow to the Codex agent — refetch changes both the preamble and the rows.
    const chip = Array.from(el.querySelectorAll('.cost-agent-chip')).find(b => b.textContent === 'Codex') as HTMLButtonElement;
    act(() => chip.click());
    await flush();

    const second = await clickExportAndRead(el);
    expect(second.lines).toContain('Agent filter,codex-cli');
    expect(second.csv).toContain('codex-row');
    expect(second.csv).not.toContain('7d-row');
    expect(second.filename).toMatch(/^kookr-cost-comparison-7d-codex-cli-.*\.csv$/);
  });

  test('export during an in-flight refetch labels the file with the query that produced the rows', async () => {
    // First fetch (7d) resolves; the second (30d) never does, so `data` still
    // holds the 7d payload while the live filter has moved to 30d.
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(makeResponse({ perTask: [taskRow({ taskName: 'Original task', taskId: 'original-id', playbookId: '7d-row' })] })),
      } as unknown as Response))
      .mockImplementation(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchSpy);
    const el = mount();
    await flush();

    const select = el.querySelector('.cost-window-select') as HTMLSelectElement;
    act(() => {
      select.value = '30d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    // Button stays enabled (prior data present); export must label from the 7d
    // query that produced the rows, NOT the live 30d filter.
    const { lines, csv, filename } = await clickExportAndRead(el);
    expect(lines).toContain('Window,7d');
    expect(lines).toContain('Agent filter,all');
    expect(lines).toContain('Search,(none)');
    expect(lines).toContain('Original task,original-id,2026-05-08T11:00:00.000Z,Claude,sonnet,7d-row,1m05s,0.1234,up,priced');
    expect(csv).toContain('7d-row');
    expect(el.querySelector('.cost-per-task-table tbody td')?.textContent).toBe('Original task');
    expect(filename).toMatch(/^kookr-cost-comparison-7d-all-.*\.csv$/);
  });

  test('buildCostComparisonCsv escapes commas, quotes and line breaks in names and other free-text fields', () => {
    const playbook: PerPlaybookRow = {
      playbookId: 'pb-x', playbookName: 'reports, "weekly"',
      perAgent: { 'claude-code': emptyAgg('claude-code', { pricedTaskCount: 1, totalCostUsd: 0.5 }) },
    };
    const csv = buildCostComparisonCsv(
      makeResponse({
        perPlaybook: [playbook],
        perTask: [taskRow({ taskName: 'Fix "login",\nhandle\rredirects', taskId: 'task,"id"', model: 'gpt-5, "codex"' })],
      }),
      { window: '7d', agent: 'all', search: '' },
    );
    // Comma + quote force quoting; inner quotes are doubled.
    expect(csv).toContain('"reports, ""weekly""",0.5000,1');
    expect(csv).toContain('"gpt-5, ""codex"""');
    expect(csv).toContain('"Fix ""login"",\nhandle\rredirects","task,""id""",2026-05-08T11:00:00.000Z');
  });

  test.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@ref', "'@ref"],
    ['\tformula', "'\tformula"],
    ['\rformula', '"\'\rformula"'],
  ])('neutralizes formula-leading task names and IDs (%j)', (value, escaped) => {
    const csv = buildCostComparisonCsv(
      makeResponse({ perTask: [taskRow({ taskName: value, taskId: value })] }),
      { window: '7d', agent: 'all', search: '' },
    );
    expect(csv).toContain(`${escaped},${escaped},2026-05-08T11:00:00.000Z`);
  });

  test('buildCostComparisonCsv neutralizes every leading formula character', () => {
    for (const lead of ['=SUM(A1)', '+1', '-1', '@ref']) {
      const csv = buildCostComparisonCsv(
        makeResponse({ perTask: [taskRow({ model: lead })] }),
        { window: '24h', agent: 'codex-cli', search: '' },
      );
      // Field is prefixed with an apostrophe so spreadsheets treat it as text.
      expect(csv).toContain(`,'${lead},`);
    }
  });
});
