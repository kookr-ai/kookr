import { describe, expect, it, vi } from 'vitest';
import {
  ghPullRequestFilesPage,
  PullRequestChanges,
  type PullRequestFile,
  type PullRequestFilesPage,
  type PullRequestRef,
} from './task-changes-pr.js';

const PR: PullRequestRef = { owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/pull/7', branch: 'feat', baseBranch: 'main' };
const FILES: PullRequestFile[] = [
  { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n a\n+b' },
  // GitHub sends no patch for a pure rename.
  { filename: 'moved.ts', status: 'renamed', previous_filename: 'old.ts', additions: 0, deletions: 0 },
  // Nor for a change to the file mode only ('changed').
  { filename: 'run.sh', status: 'changed', additions: 0, deletions: 0 },
  // Nor for a binary file.
  { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
];

describe('PullRequestChanges (#4024 slice 3)', () => {
  it('shares one GitHub request between a list and the files asked for while it runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchPage = vi.fn<PullRequestFilesPage>(async () => { await gate; return FILES; });
    const changes = new PullRequestChanges(fetchPage);

    const pending = Promise.all([
      changes.list(PR), changes.file(PR, 'a.ts'), changes.file(PR, 'moved.ts'), changes.file(PR, 'run.sh'), changes.file(PR, 'logo.png'),
    ]);
    release();
    const [list, a, moved, modeOnly, binary] = await pending;

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(list?.kind === 'ok' && list.files).toEqual([
      { path: 'a.ts', status: 'modified', added: 1, removed: 0 },
      { path: 'moved.ts', oldPath: 'old.ts', status: 'renamed', added: 0, removed: 0 },
      { path: 'run.sh', status: 'modified', added: 0, removed: 0 },
      { path: 'logo.png', status: 'added', added: null, removed: null },
    ]);
    expect(a).toEqual({ kind: 'patch', path: 'a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }] });
    expect(moved).toEqual({ kind: 'patch', path: 'moved.ts', hunks: [] });
    expect(modeOnly).toEqual({ kind: 'patch', path: 'run.sh', hunks: [] });
    expect(binary).toEqual({ kind: 'no_patch', path: 'logo.png' });
  });

  it('asks GitHub again after 60 seconds, or at once when fresh', async () => {
    let now = 1_000_000;
    const fetchPage = vi.fn<PullRequestFilesPage>(async () => FILES);
    const changes = new PullRequestChanges(fetchPage, () => now);

    await changes.list(PR);
    now += 59_999;
    await changes.list(PR);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    now += 1;
    await changes.list(PR);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await changes.list(PR, { fresh: true });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('does not keep a failed ask, so the next request tries again', async () => {
    const fetchPage = vi.fn<PullRequestFilesPage>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(FILES);
    const changes = new PullRequestChanges(fetchPage);

    expect(await changes.list(PR)).toBeNull();
    expect(await changes.file(PR, 'a.ts')).toMatchObject({ kind: 'patch' });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 20 lists, dropping the oldest', async () => {
    const fetchPage = vi.fn<PullRequestFilesPage>(async () => FILES);
    const changes = new PullRequestChanges(fetchPage);
    for (let n = 1; n <= 21; n++) await changes.list({ ...PR, number: n });
    expect(fetchPage).toHaveBeenCalledTimes(21);

    await changes.list({ ...PR, number: 21 });
    expect(fetchPage).toHaveBeenCalledTimes(21);
    await changes.list({ ...PR, number: 1 });
    expect(fetchPage).toHaveBeenCalledTimes(22);
  });
});

describe('ghPullRequestFilesPage', () => {
  it('refuses an owner or repository that is not a plain name, without running gh', async () => {
    for (const bad of [{ owner: '..' }, { owner: 'a/b' }, { repo: '.' }, { repo: '' }, { number: 0 }, { number: 1.5 }]) {
      expect(await ghPullRequestFilesPage({ ...PR, ...bad }, 1)).toBeNull();
    }
  });
});
