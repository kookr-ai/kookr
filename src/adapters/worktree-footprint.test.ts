import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { measureWorktreeFootprint } from './worktree-footprint.js';

// These vars redirect git at an ambient repo. They are set in the environment
// while a git hook (e.g. pre-push) runs `pnpm test`, so a bare `git -C <tmp>`
// here would inherit them and operate on the REAL repo instead of the fixture
// — corrupting it. Strip them, exactly like the adapter under test does.
const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_WORK_TREE',
];
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) delete env[name];
  return env;
}
function git(args: string[]): void {
  execFileSync('git', args, { stdio: 'pipe', env: cleanGitEnv() });
}

describe('measureWorktreeFootprint', () => {
  let root: string;
  let mainRepo: string;
  let worktreePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wt-footprint-'));
    mainRepo = join(root, 'main-repo');
    worktreePath = join(root, 'linked-worktree');

    git(['init', mainRepo]);
    git(['-C', mainRepo, 'config', 'user.email', 'test@example.com']);
    git(['-C', mainRepo, 'config', 'user.name', 'Test User']);
    await writeFile(join(mainRepo, 'README.md'), 'hello\n');
    git(['-C', mainRepo, 'add', 'README.md']);
    git(['-C', mainRepo, 'commit', '-m', 'initial commit']);
    git(['-C', mainRepo, 'worktree', 'add', worktreePath, '-b', 'feature-branch']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('returns a positive footprint and a recent last-touched timestamp for a real linked worktree', async () => {
    const result = await measureWorktreeFootprint(worktreePath);

    expect(result.footprintBytes).not.toBeNull();
    expect(result.footprintBytes as number).toBeGreaterThan(0);

    expect(result.lastTouchedMs).not.toBeNull();
    const lastTouchedMs = result.lastTouchedMs as number;
    expect(lastTouchedMs).toBeGreaterThan(Date.now() - 5 * 60 * 1000);
    expect(lastTouchedMs).toBeLessThan(Date.now() + 60 * 1000);
  });

  test('resolves to nulls for a non-existent path instead of throwing', async () => {
    const result = await measureWorktreeFootprint('/definitely/does/not/exist/xyz');
    expect(result).toEqual({ footprintBytes: null, lastTouchedMs: null });
  });
});
