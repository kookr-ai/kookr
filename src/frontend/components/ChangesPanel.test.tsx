// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TaskChangeFileResponse, TaskChangesResponse } from '../../shared/contracts/task-changes.js';
import { ChangesPanel, editPathInRepo, type ChangesEdit } from './ChangesPanel.js';

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

/** `taskId: null` renders the panel of an agent with no task. */
async function render(taskId: string | null = 'task-1', edit: ChangesEdit | null = null, onCloseEdit?: () => void) {
  root = createRoot(container);
  act(() => { root!.render(<ChangesPanel taskId={taskId ?? undefined} edit={edit} onCloseEdit={onCloseEdit} />); });
  await flush();
}

const EDIT_PATCH = {
  kind: 'edit',
  filePath: '/work/widget/src/app/WidgetExport.tsx',
  structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-was', '+now'] }],
  oldString: 'was',
  newString: 'now',
  serverStartedAt: '2026-11-16T00:00:00.000Z',
};

function editOf(filePath: string): ChangesEdit {
  return { agentId: 'agent-1', toolUseId: 'tu-1', filePath, openedAt: '2026-11-16T00:00:00.000Z' };
}

const q = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="changes-row"]')];

const LIST: TaskChangesResponse = {
  kind: 'ok',
  baseRef: 'origin/staging',
  branch: 'feat-widget-export',
  repoRoot: '/work/widget',
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
    routes['/api/tasks/task-1/changes'] = { status: 200, body: LIST };
    routes['/api/tasks/task-1/changes?fresh=1'] = { status: 200, body: { ...LIST, files: [LIST.files[0]] } };
    await render();
    act(() => rows()[0].click());
    await flush();
    act(() => q('changes-refresh')!.click());
    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
    // Refresh asks again past the server's cached pull request list.
    expect(calls.filter((c) => c.startsWith('/api/tasks/task-1/changes') && !c.includes('/file'))).toEqual([
      '/api/tasks/task-1/changes',
      '/api/tasks/task-1/changes?fresh=1',
    ]);
    expect(calls.filter((c) => c.includes('/changes/file'))).toHaveLength(2);
  });

  test.each([
    ['worktree_gone', "This task's worktree was removed, and no pull request of its own is known."],
    ['pull_request_unreachable', "This task's worktree was removed, and GitHub did not answer for its pull request's files. Press Refresh to try again."],
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

  test('an opened edit shows its own patch above the list and marks its file row', async () => {
    routes['/api/agents/agent-1/edit-events/tu-1'] = { status: 200, body: EDIT_PATCH };
    await render('task-1', editOf('/work/widget/src/app/WidgetExport.tsx'));

    const card = q('changes-edit')!;
    expect(card.querySelector('.diff-pane-path')?.textContent).toBe('/work/widget/src/app/WidgetExport.tsx');
    expect([...card.querySelectorAll('.diff-line')].map((l) => l.textContent)).toEqual(['-was', '+now']);
    // The card comes before the list, so it is what the operator sees first.
    expect(card.compareDocumentPosition(rows()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rows().map((r) => r.getAttribute('data-edit-target'))).toEqual(['true', null, null]);
    expect(rows()[0].textContent).toContain('opened edit');
  });

  test('an edit outside the repository still shows its patch, with no row marked', async () => {
    routes['/api/agents/agent-1/edit-events/tu-1'] = { status: 200, body: { ...EDIT_PATCH, filePath: '/tmp/scratch.ts' } };
    await render('task-1', editOf('/tmp/scratch.ts'));

    expect(q('changes-edit')?.querySelectorAll('.diff-line')).toHaveLength(2);
    expect(rows()).toHaveLength(3);
    expect(rows().some((r) => r.hasAttribute('data-edit-target'))).toBe(false);
  });

  test('the edit shows even when the change list is unavailable', async () => {
    routes['/api/tasks/task-1/changes'] = { status: 200, body: { kind: 'unavailable', reason: 'worktree_gone' } };
    routes['/api/agents/agent-1/edit-events/tu-1'] = { status: 200, body: EDIT_PATCH };
    await render('task-1', editOf('/work/widget/src/app/WidgetExport.tsx'));

    expect(q('changes-edit')?.querySelectorAll('.diff-line')).toHaveLength(2);
    expect(q('changes-empty')).not.toBeNull();
  });

  test('with no task only the edit shows, and git is never asked', async () => {
    routes['/api/agents/agent-1/edit-events/tu-1'] = { status: 200, body: EDIT_PATCH };
    const onClose = vi.fn();
    await render(null, editOf('/work/widget/src/app/WidgetExport.tsx'), onClose);

    expect(q('changes-edit')).not.toBeNull();
    expect(q('changes-head')).toBeNull();
    expect(calls).toEqual(['/api/agents/agent-1/edit-events/tu-1']);
    act(() => container.querySelector<HTMLButtonElement>('.diff-pane-close')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a list from the pull request names it, and a file without a patch says why', async () => {
    routes['/api/tasks/task-1/changes'] = {
      status: 200,
      body: {
        kind: 'ok', source: 'pull_request', pullRequest: { number: 4070, url: 'https://github.com/o/r/pull/4070' },
        baseRef: 'main', branch: 'feat-widget-export', repoRoot: null,
        files: [{ path: 'big.json', status: 'modified', added: 9000, removed: 0 }], truncated: false,
      },
    };
    routes['/api/tasks/task-1/changes/file?path=big.json'] = { status: 200, body: { kind: 'no_patch', path: 'big.json' } };
    routes['/api/agents/agent-1/edit-events/tu-1'] = { status: 200, body: EDIT_PATCH };
    await render('task-1', editOf('/work/widget/big.json'));

    expect(q('changes-summary')?.textContent).toBe('1 file against main on feat-widget-export, from pull request #4070 (no worktree to read)');
    expect(q('changes-summary')?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/pull/4070');
    // No repository root to match against, so no row claims the edit.
    expect(rows()[0].hasAttribute('data-edit-target')).toBe(false);
    act(() => rows()[0].click());
    await flush();
    expect(q('changes-diff')?.textContent).toBe('GitHub shows no text diff for this file (binary, or too large).');
  });
});

describe('editPathInRepo', () => {
  test('maps an absolute path inside the repository to its change-list path', () => {
    expect(editPathInRepo('/work/widget/src/a.ts', '/work/widget')).toBe('src/a.ts');
    expect(editPathInRepo('/work/widget/src/a.ts', '/work/widget/')).toBe('src/a.ts');
  });

  test('rejects a path outside the repository, including a sibling with the same prefix', () => {
    expect(editPathInRepo('/tmp/a.ts', '/work/widget')).toBeNull();
    expect(editPathInRepo('/work/widget2/a.ts', '/work/widget')).toBeNull();
  });

  test('keeps a relative path as given', () => {
    expect(editPathInRepo('./src/a.ts', '/work/widget')).toBe('src/a.ts');
    expect(editPathInRepo('src/a.ts', '/work/widget')).toBe('src/a.ts');
  });
});
