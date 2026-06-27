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
      taskCount: 4,
      terminalTaskCount: 4,
      completedTaskCount: 2,
      cancelledTaskCount: 1,
      terminatedTaskCount: 1,
      activeTaskCount: 0,
      completionRate: 0.5,
      prTaskCount: 1,
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
    byAgent: [],
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
    expect(el.textContent).toContain('Cost is unknown, not zero.');
    expect(el.textContent).toContain('Cancelled after prompt');
    expect(el.querySelector('.outcome-findings-list')?.tagName).toBe('UL');
    expect(el.querySelector('.outcome-finding')?.tagName).toBe('LI');
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
