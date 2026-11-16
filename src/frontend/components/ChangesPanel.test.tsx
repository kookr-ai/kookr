// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TaskChangeFileResponse, TaskChangesResponse } from '../../shared/contracts/task-changes.js';
import { ChangesPanel } from './ChangesPanel.js';

type Reply = { status: number; body: unknown };

let container: HTMLDivElement;
let root: Root | null;
let calls: string[];
let routes: Record<string, Reply | Reply[]>;

function reply(url: string): Reply {
  const r = routes[url];
  if (!r) return { status: 500, body: null };
  if (Array.isArray(r)) return r.length > 1 ? r.shift()! : r[0];
  return r;
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(taskId = 'task-1') {
  root = createRoot(container);
  act(() => { root!.render(<ChangesPanel taskId={taskId} />); });
  await flush();
}

const q = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="changes-row"]')];

const LIST: TaskChangesResponse = {
  kind: 'ok',
  baseRef: 'origin/staging',
  branch: 'feat-widget-export',
  files: [
    { path: 'src/app/WidgetExport.tsx', status: 'modified', added: 5, removed: 2 },
    { path: 'logo.png', status: 'added', added: null, removed: null },
    { path: 'src/moved.ts', oldPath: 'src/old.ts', status: 'renamed', added: 0, removed: 0 },
  ],
  truncated: false,
};

const PATCH: TaskChangeFileResponse = {
  kind: 'patch',
  path: 'src/app/WidgetExport.tsx',
  hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old line', '+new line'] }],
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  calls = [];
  routes = {
    '/api/tasks/task-1/changes': { status: 200, body: LIST },
    '/api/tasks/task-1/changes/file?path=src%2Fapp%2FWidgetExport.tsx': { status: 200, body: PATCH },
    '/api/tasks/task-1/changes/file?path=src%2Fmoved.ts': { status: 200, body: { kind: 'patch', path: 'src/moved.ts', hunks: [] } },
    '/api/tasks/task-1/changes/file?path=logo.png': { status: 200, body: { kind: 'binary', path: 'logo.png' } },
  };
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url);
    const r = reply(url);
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) } as Response);
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ChangesPanel (#4024)', () => {
  test('lists the files with the base, the branch and the line counts', async () => {
    await render();
    expect(q('changes-summary')?.textContent).toBe('3 files against origin/staging on feat-widget-export');
    expect(container.querySelector('.changes-head .changes-counts')?.textContent).toBe('+5 −2');
    expect(rows().map((r) => r.textContent)).toEqual([
      '▸Msrc/app/WidgetExport.tsx+5 −2',
      '▸Alogo.pngbinary',
      '▸Rsrc/moved.ts+0 −0',
    ]);
    expect(rows()[2].title).toBe('src/old.ts → src/moved.ts');
    expect(calls).toEqual(['/api/tasks/task-1/changes']);
  });

  test('a row opens its diff under it and closes it again', async () => {
    await render();
    const row = rows()[0];
    expect(row.getAttribute('aria-expanded')).toBe('false');
    act(() => row.click());
    await flush();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const diff = q('changes-diff')!;
    expect([...diff.querySelectorAll('.diff-line')].map((l) => [l.className, l.textContent])).toEqual([
      ['diff-line diff-ctx', ' keep'],
      ['diff-line diff-del', '-old line'],
      ['diff-line diff-add', '+new line'],
    ]);
    act(() => row.click());
    expect(q('changes-diff')).toBeNull();
  });

  test('binary files and pure renames say so instead of showing an empty diff', async () => {
    await render();
    act(() => rows()[1].click());
    act(() => rows()[2].click());
    await flush();
    const notes = [...container.querySelectorAll('[data-testid="changes-diff"]')].map((d) => d.textContent);
    expect(notes).toEqual(['Binary file; no text diff.', 'Renamed; the content is unchanged.']);
  });

  test('a file that left the list asks for a refresh', async () => {
    routes['/api/tasks/task-1/changes/file?path=src%2Fapp%2FWidgetExport.tsx'] = { status: 404, body: { error: 'not_in_change_list' } };
    await render();
    act(() => rows()[0].click());
    await flush();
    expect(q('changes-diff')?.textContent).toBe('This file is no longer in the change list. Press Refresh.');
  });

  test('Refresh reloads the list and the open diffs, keeping them open', async () => {
    routes['/api/tasks/task-1/changes'] = [
      { status: 200, body: LIST },
      { status: 200, body: { ...LIST, files: [LIST.files[0]] } },
    ];
    await render();
    act(() => rows()[0].click());
    await flush();
    act(() => q('changes-refresh')!.click());
    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
    expect(calls.filter((c) => c === '/api/tasks/task-1/changes')).toHaveLength(2);
    expect(calls.filter((c) => c.includes('/changes/file'))).toHaveLength(2);
  });

  test.each([
    ['worktree_gone', "This task's worktree was removed. Its pull request shows what was pushed."],
    ['no_cwd', 'No working directory is recorded for this task.'],
    ['not_git', 'This task does not run in a git repository.'],
  ] as const)('explains a %s task instead of an empty list', async (reason, text) => {
    routes['/api/tasks/task-1/changes'] = { status: 200, body: { kind: 'unavailable', reason } };
    await render();
    expect(q('changes-empty')?.textContent).toBe(text);
    expect(rows()).toHaveLength(0);
    expect(q('changes-refresh')).not.toBeNull();
  });

  test('a branch with no changes says so', async () => {
    routes['/api/tasks/task-1/changes'] = { status: 200, body: { ...LIST, files: [] } };
    await render();
    expect(q('changes-summary')?.textContent).toBe('No changes against origin/staging on feat-widget-export');
    expect(rows()).toHaveLength(0);
  });

  test('a cut list says so', async () => {
    routes['/api/tasks/task-1/changes'] = { status: 200, body: { ...LIST, truncated: true } };
    await render();
    expect(container.textContent).toContain('Only the first 3 files are listed.');
    routes['/api/tasks/task-1/changes'] = { status: 200, body: LIST };
    act(() => q('changes-refresh')!.click());
    await flush();
    expect(container.textContent).not.toContain('Only the first');
  });

  test('a server error is reported', async () => {
    routes['/api/tasks/task-1/changes'] = { status: 500, body: null };
    await render();
    expect(q('changes-empty')?.textContent).toBe('Could not load the changes. Check the server log.');
  });
});
