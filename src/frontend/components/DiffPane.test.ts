// @vitest-environment jsdom

import React from 'react';
import { describe, expect, test, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffPane, countLineChanges } from './DiffPane.js';

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();

function mount(props: Partial<Parameters<typeof DiffPane>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      React.createElement(DiffPane, {
        agentId: 'kookr-abc',
        toolUseId: 'tu_1',
        filePath: '/src/foo.ts',
        openedAt: '2026-04-21T00:00:00.000Z',
        onClose,
        ...props,
      }),
    );
  });
  return container;
}

async function flush() {
  // Let microtasks + useEffect fetch complete
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  onClose.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

function mockFetchOnce(response: unknown, { status = 200 } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(response),
      } as unknown as Response),
    ),
  );
}

describe('DiffPane rendering', () => {
  test('renders loading state initially', () => {
    mockFetchOnce({}, { status: 200 }); // won't resolve before we assert
    const el = mount();
    expect(el.querySelector('.diff-pane-loading')?.textContent).toMatch(/loading/i);
  });

  test('renders unified diff with + / - / context markers for edit', async () => {
    mockFetchOnce({
      kind: 'edit',
      filePath: '/src/foo.ts',
      oldString: 'a',
      newString: 'b',
      structuredPatch: [
        {
          oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
          lines: [' context', '-removed', '+added'],
        },
      ],
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount();
    await flush();

    expect(el.querySelector('.diff-hunk-header')?.textContent).toContain('@@ -1,2 +1,2 @@');
    expect(el.querySelectorAll('.diff-add').length).toBe(1);
    expect(el.querySelectorAll('.diff-del').length).toBe(1);
    expect(el.querySelectorAll('.diff-ctx').length).toBe(1);
    expect(el.querySelector('.diff-add')?.textContent).toBe('+added');
    expect(el.querySelector('.diff-del')?.textContent).toBe('-removed');
  });

  test('shows "New file" badge for write with empty originalFile', async () => {
    mockFetchOnce({
      kind: 'write',
      filePath: '/new.ts',
      originalFile: '',
      structuredPatch: [
        { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'] },
      ],
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount({ filePath: '/new.ts' });
    await flush();

    const badge = el.querySelector('.diff-pane-badge-new');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toMatch(/new file/i);
  });

  test('does NOT show "New file" badge for write with non-empty originalFile', async () => {
    mockFetchOnce({
      kind: 'write',
      filePath: '/existing.ts',
      originalFile: 'existing content\nline two\n',
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
      ],
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount({ filePath: '/existing.ts' });
    await flush();

    expect(el.querySelector('.diff-pane-badge-new')).toBeNull();
  });

  test('shows unsupported message for NotebookEdit response', async () => {
    mockFetchOnce({
      kind: 'unsupported',
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount();
    await flush();

    expect(el.querySelector('.diff-pane-unsupported')?.textContent).toMatch(/not supported/i);
  });

  test('shows "no changes" when structuredPatch is empty', async () => {
    mockFetchOnce({
      kind: 'edit',
      filePath: '/src/foo.ts',
      oldString: '', newString: '',
      structuredPatch: [],
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount();
    await flush();

    expect(el.querySelector('.diff-pane-empty')?.textContent).toMatch(/no changes/i);
  });
});

describe('countLineChanges', () => {
  test('counts + and - marker lines, excluding context and no-newline markers', () => {
    const hunks = [
      {
        oldStart: 1, oldLines: 3, newStart: 1, newLines: 4,
        lines: [' context', '-removed', '+added one', '+added two', '\\ No newline at end of file'],
      },
      {
        oldStart: 10, oldLines: 1, newStart: 11, newLines: 0,
        lines: ['-only removed'],
      },
    ];
    expect(countLineChanges(hunks)).toEqual({ added: 2, removed: 2 });
  });

  test('returns zeros for an empty patch', () => {
    expect(countLineChanges([])).toEqual({ added: 0, removed: 0 });
  });

  test('new-file patch counts additions cleanly', () => {
    const hunks = [
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+line one', '+line two'] },
    ];
    expect(countLineChanges(hunks)).toEqual({ added: 2, removed: 0 });
  });
});

describe('DiffPane — header stat badge', () => {
  test('renders +N −M reflecting the shown patch', async () => {
    mockFetchOnce({
      kind: 'edit',
      filePath: '/src/foo.ts',
      oldString: 'a', newString: 'b',
      structuredPatch: [
        {
          oldStart: 1, oldLines: 3, newStart: 1, newLines: 4,
          lines: [' context', '-removed', '+added one', '+added two', '\\ No newline at end of file'],
        },
      ],
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount();
    await flush();

    expect(el.querySelector('.diff-pane-stat-add')?.textContent).toBe('+2');
    expect(el.querySelector('.diff-pane-stat-del')?.textContent).toBe('−1');
  });

  test('no stat badge for unsupported responses', async () => {
    mockFetchOnce({ kind: 'unsupported', serverStartedAt: '2026-04-21T00:00:00.000Z' });
    const el = mount();
    await flush();

    expect(el.querySelector('.diff-pane-stat')).toBeNull();
  });
});

describe('DiffPane — 404 handling', () => {
  test('event_not_found with same serverStartedAt → generic "not found" message', async () => {
    mockFetchOnce(
      { error: 'not_found', reason: 'event_not_found', serverStartedAt: '2026-04-21T00:00:00.000Z' },
      { status: 404 },
    );
    const el = mount({ openedAt: '2026-04-21T00:00:00.000Z' });
    await flush();

    const err = el.querySelector('.diff-pane-error');
    expect(err?.textContent).toMatch(/not found/i);
    expect(err?.classList.contains('is-restarted')).toBe(false);
  });

  test('event_not_found with newer serverStartedAt → restart-aware message', async () => {
    mockFetchOnce(
      { error: 'not_found', reason: 'event_not_found', serverStartedAt: '2026-04-21T01:00:00.000Z' },
      { status: 404 },
    );
    const el = mount({ openedAt: '2026-04-21T00:00:00.000Z' });
    await flush();

    const err = el.querySelector('.diff-pane-error');
    expect(err?.textContent).toMatch(/restarted/i);
    expect(err?.classList.contains('is-restarted')).toBe(true);
  });

  test('agent_unknown shows specific message', async () => {
    mockFetchOnce(
      { error: 'not_found', reason: 'agent_unknown', serverStartedAt: '2026-04-21T00:00:00.000Z' },
      { status: 404 },
    );
    const el = mount({ openedAt: '2026-04-21T00:00:00.000Z' });
    await flush();

    expect(el.querySelector('.diff-pane-error')?.textContent).toMatch(/no longer tracked/i);
  });
});

describe('DiffPane — close triggers', () => {
  // Escape-to-close is owned by DetailPanel's capture-phase window listener,
  // not DiffPane itself (see src/frontend/components/DetailPanel.tsx). The
  // end-to-end Escape flow is covered by the Playwright spec at
  // e2e/activity-diff.spec.ts.

  test('close button calls onClose', async () => {
    mockFetchOnce({ kind: 'unsupported', serverStartedAt: '2026-04-21T00:00:00.000Z' });
    const el = mount();
    await flush();

    const btn = el.querySelector('.diff-pane-close') as HTMLButtonElement;
    act(() => btn.click());
    expect(onClose).toHaveBeenCalled();
  });
});
