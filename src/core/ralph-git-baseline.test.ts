import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import {
  createBaselineTag,
  computeDiffStats,
  parseShortstat,
} from './ralph-git-baseline.js';

/**
 * Build a clean env that ignores the user's global / system git config and
 * any inherited GIT_* vars. Necessary so commits don't fail under signing
 * configs, custom templates, or global commit hooks.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_')) continue;
    cleaned[k] = v;
  }
  return {
    ...cleaned,
    GIT_AUTHOR_NAME: 'ralph',
    GIT_AUTHOR_EMAIL: 'ralph@test.invalid',
    GIT_COMMITTER_NAME: 'ralph',
    GIT_COMMITTER_EMAIL: 'ralph@test.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: cleanGitEnv() }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });
}

async function makeRepo(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], dir);
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await runGit(['add', '.'], dir);
  await runGit(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'init'], dir);
}

describe('parseShortstat', () => {
  it('extracts files / insertions / deletions from a full line', () => {
    expect(parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)')).toEqual({
      filesChanged: 3,
      insertions: 12,
      deletions: 4,
    });
  });

  it('handles singular "file changed"', () => {
    expect(parseShortstat(' 1 file changed, 5 insertions(+)')).toEqual({
      filesChanged: 1,
      insertions: 5,
      deletions: 0,
    });
  });

  it('handles deletions-only output', () => {
    expect(parseShortstat(' 2 files changed, 3 deletions(-)')).toEqual({
      filesChanged: 2,
      insertions: 0,
      deletions: 3,
    });
  });

  it('returns all zeros for empty output (no diff)', () => {
    expect(parseShortstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
    expect(parseShortstat('   \n')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });
});

describe('createBaselineTag', () => {
  let dir: string;
  // Strip GIT_* from process.env for these tests so the SUT's git calls
  // operate on the temp repo (cwd) instead of being hijacked by GIT_DIR /
  // GIT_WORK_TREE that pre-push hooks leak into the test process.
  const savedGitEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('GIT_')) {
        savedGitEnv[k] = v;
        delete process.env[k];
      }
    }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  });

  afterAll(() => {
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.GIT_CONFIG_SYSTEM;
    for (const [k, v] of Object.entries(savedGitEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralph-git-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the tag name on success', async () => {
    await makeRepo(dir);
    const ref = await createBaselineTag(1, { cwd: dir });
    expect(ref).toBe('ralph/iter-1-start');
    const { stdout } = await runGit(['tag', '--list'], dir);
    expect(stdout).toContain('ralph/iter-1-start');
  });

  it('overwrites an existing tag (post-crash re-run safety)', async () => {
    await makeRepo(dir);
    await createBaselineTag(1, { cwd: dir });
    await writeFile(join(dir, 'b.txt'), 'two\n');
    await runGit(['add', '.'], dir);
    await runGit(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'second'], dir);
    const ref = await createBaselineTag(1, { cwd: dir });
    expect(ref).toBe('ralph/iter-1-start');
  });

  it('returns null when cwd is not a git repo', async () => {
    const ref = await createBaselineTag(1, { cwd: dir });
    expect(ref).toBeNull();
  });
});

describe('computeDiffStats', () => {
  let dir: string;
  const savedGitEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('GIT_')) {
        savedGitEnv[k] = v;
        delete process.env[k];
      }
    }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  });

  afterAll(() => {
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.GIT_CONFIG_SYSTEM;
    for (const [k, v] of Object.entries(savedGitEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralph-diff-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns zero stats when no changes since baseline', async () => {
    await makeRepo(dir);
    await createBaselineTag(1, { cwd: dir });
    const stats = await computeDiffStats('ralph/iter-1-start', { cwd: dir });
    expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it('counts insertions across new files', async () => {
    await makeRepo(dir);
    await createBaselineTag(1, { cwd: dir });
    await writeFile(join(dir, 'b.txt'), 'two\nthree\n');
    await runGit(['add', '.'], dir);
    const stats = await computeDiffStats('ralph/iter-1-start', { cwd: dir });
    expect(stats?.filesChanged).toBe(1);
    expect(stats?.insertions).toBe(2);
    expect(stats?.deletions).toBe(0);
  });

  it('returns null when baseline ref is missing', async () => {
    await makeRepo(dir);
    const stats = await computeDiffStats('ralph/iter-99-start', { cwd: dir });
    expect(stats).toBeNull();
  });

  it('returns null when cwd is not a git repo', async () => {
    const stats = await computeDiffStats('any-ref', { cwd: dir });
    expect(stats).toBeNull();
  });

  it('returns null for empty baseline ref string (defensive)', async () => {
    const stats = await computeDiffStats('', { cwd: dir });
    expect(stats).toBeNull();
  });
});
