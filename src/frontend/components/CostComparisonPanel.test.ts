// @vitest-environment jsdom

import React from 'react';
import { describe, expect, test, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CostComparisonPanel, buildCostComparisonCsv } from './CostComparisonPanel.js';
import type { CostComparisonResponse, AggregateMetrics, PerPlaybookRow, PerTaskRow } from '../../shared/contracts/cost-comparison.js';

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
      'claude-code': emptyAgg('claude-code', { taskCount: 18, pricedTaskCount: 18, totalCostUsd: 4.21, medianDurationMs: 720_000 }),
      'codex-cli':   emptyAgg('codex-cli',   { taskCount: 12, pricedTaskCount: 12, totalCostUsd: 6.83, medianDurationMs: 1_080_000 }),
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
        stats: ['tasks 18', 'total $4.21', 'med dur 12m00s', 'p95 dur —', 'max dur —', '👍 rate —'],
      },
      {
        title: 'Codex',
        stats: ['tasks 12', 'total $6.83', 'med dur 18m00s', 'p95 dur —', 'max dur —', '👍 rate —'],
      },
    ]);
  });

  test('renders the "—" cost cell with a dataQuality tooltip when cost is null', async () => {
    const response = makeResponse({
      perTask: [{
        taskId: 't1', agent: 'codex-cli', model: null, playbookId: null,
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
  });

  test('renders running duration and missing-usage badge', async () => {
    const response = makeResponse({
      perTask: [{
        taskId: 't1', agent: 'claude-code', model: null, playbookId: null,
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
      taskId: 't1', agent: 'claude-code', model: 'sonnet', playbookId: 'oss-pr',
      startedAt: '2026-05-08T11:00:00Z', status: 'completed', isTerminal: true, durationMs: 65_000,
      inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0,
      estimatedCostUsd: 0.1234, thumb: 'up', dataQuality: 'complete',
      ...overrides,
    };
  }

  /**
   * Click Export CSV and capture the serialised blob text. Stubs
   * URL.createObjectURL (unimplemented in jsdom) so the download path runs
   * without a real navigation.
   */
  async function clickExportAndRead(el: HTMLElement): Promise<{ csv: string; filename: string }> {
    const blobs: Blob[] = [];
    let filename = '';
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:mock'; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download;
    });
    const btn = el.querySelector('.cost-export-btn') as HTMLButtonElement;
    act(() => btn.click());
    clickSpy.mockRestore();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    const csv = blobs[0] ? await blobs[0].text() : '';
    return { csv, filename };
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

    const { csv, filename } = await clickExportAndRead(el);
    expect(csv).toContain('Per playbook');
    expect(csv).toContain('Playbook,Claude avg (USD),Claude n,Codex avg (USD),Codex n,Cost ratio');
    // claude avg = 1.86/6 = 0.3100, codex avg = 1.92/4 = 0.4800 → Codex 1.55×
    expect(csv).toContain('oss-pr,0.3100,6,0.4800,4,Codex 1.55×');
    expect(csv).toContain('Per task');
    expect(csv).toContain('Started,Agent,Model,Playbook,Duration,Cost (USD),Feedback,Quality');
    // duration 65_000ms → 1m05s, cost 0.1234, thumb up, complete → priced
    expect(csv).toContain('2026-05-08T11:00:00.000Z,Claude,sonnet,oss-pr,1m05s,0.1234,up,priced');
    expect(filename).toMatch(/^kookr-cost-comparison-7d-all-.*\.csv$/);
  });

  test('exported rows follow the active window and agent filter', async () => {
    mockFetchSequential([
      { body: makeResponse({ perTask: [taskRow({ taskId: 'a', playbookId: '7d-row' })] }) },
      { body: makeResponse({ perTask: [taskRow({ taskId: 'b', playbookId: '30d-row' })] }) },
    ]);
    const el = mount();
    await flush();

    const first = await clickExportAndRead(el);
    expect(first.csv).toContain('Window,7d');
    expect(first.csv).toContain('7d-row');
    expect(first.csv).not.toContain('30d-row');

    const select = el.querySelector('.cost-window-select') as HTMLSelectElement;
    act(() => {
      select.value = '30d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const second = await clickExportAndRead(el);
    expect(second.csv).toContain('Window,30d');
    expect(second.csv).toContain('30d-row');
    expect(second.csv).not.toContain('7d-row');
  });

  test('buildCostComparisonCsv escapes commas and quotes in free-text fields', () => {
    const playbook: PerPlaybookRow = {
      playbookId: 'pb-x', playbookName: 'reports, "weekly"',
      perAgent: { 'claude-code': emptyAgg('claude-code', { pricedTaskCount: 1, totalCostUsd: 0.5 }) },
    };
    const csv = buildCostComparisonCsv(
      makeResponse({
        perPlaybook: [playbook],
        perTask: [taskRow({ model: 'gpt-5, "codex"' })],
      }),
      { window: '7d', agent: 'all', search: '' },
    );
    // Comma + quote force quoting; inner quotes are doubled.
    expect(csv).toContain('"reports, ""weekly""",0.5000,1');
    expect(csv).toContain('"gpt-5, ""codex"""');
  });

  test('buildCostComparisonCsv neutralizes leading formula characters', () => {
    const csv = buildCostComparisonCsv(
      makeResponse({ perTask: [taskRow({ model: '=SUM(A1:A9)' })] }),
      { window: '24h', agent: 'codex-cli', search: '' },
    );
    expect(csv).toContain(`'=SUM(A1:A9)`);
  });
});
