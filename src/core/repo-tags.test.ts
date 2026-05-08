import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRepoTags, repoTagsAllow } from './repo-tags.js';

describe('repoTagsAllow', () => {
  test('absent or empty playbook tags → always allow', () => {
    expect(repoTagsAllow(undefined, [])).toBe(true);
    expect(repoTagsAllow([], [])).toBe(true);
    expect(repoTagsAllow(undefined, ['github'])).toBe(true);
  });

  test('intersection → allow', () => {
    expect(repoTagsAllow(['github', 'oss'], ['github'])).toBe(true);
    expect(repoTagsAllow(['oss'], ['oss', 'rust'])).toBe(true);
  });

  test('no intersection → deny', () => {
    expect(repoTagsAllow(['github'], [])).toBe(false);
    expect(repoTagsAllow(['github'], ['rust'])).toBe(false);
  });
});

describe('detectRepoTags', () => {
  let tmp: string;
  let originalRepoTags: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-repo-tags-'));
    originalRepoTags = process.env.KOOKR_REPO_TAGS;
    delete process.env.KOOKR_REPO_TAGS;
  });

  afterEach(async () => {
    if (originalRepoTags === undefined) delete process.env.KOOKR_REPO_TAGS;
    else process.env.KOOKR_REPO_TAGS = originalRepoTags;
    await rm(tmp, { recursive: true, force: true });
  });

  test('returns empty array for a directory with no signals', async () => {
    expect(await detectRepoTags(tmp)).toEqual([]);
  });

  test('reads tags from .kookr/repo-tags', async () => {
    await mkdir(join(tmp, '.kookr'), { recursive: true });
    await writeFile(join(tmp, '.kookr', 'repo-tags'), 'oss\nrust\n');
    const tags = await detectRepoTags(tmp);
    expect(tags.sort()).toEqual(['oss', 'rust']);
  });

  test('ignores blank lines and # comments', async () => {
    await mkdir(join(tmp, '.kookr'), { recursive: true });
    await writeFile(
      join(tmp, '.kookr', 'repo-tags'),
      '# comment line\noss\n\n# another\nrust\n',
    );
    const tags = await detectRepoTags(tmp);
    expect(tags.sort()).toEqual(['oss', 'rust']);
  });

  test('KOOKR_REPO_TAGS env short-circuits filesystem and git', async () => {
    process.env.KOOKR_REPO_TAGS = 'github,custom';
    await mkdir(join(tmp, '.kookr'), { recursive: true });
    await writeFile(join(tmp, '.kookr', 'repo-tags'), 'should-be-ignored');
    const tags = await detectRepoTags(tmp);
    expect(tags.sort()).toEqual(['custom', 'github']);
  });

  test('KOOKR_REPO_TAGS empty string → empty tags (forces "no tags" for tests)', async () => {
    process.env.KOOKR_REPO_TAGS = '';
    await mkdir(join(tmp, '.kookr'), { recursive: true });
    await writeFile(join(tmp, '.kookr', 'repo-tags'), 'should-be-ignored');
    expect(await detectRepoTags(tmp)).toEqual([]);
  });

  test('non-github remote does not produce github tag', async () => {
    await initGitWithRemote(tmp, 'https://gitlab.com/foo/bar.git');
    const tags = await detectRepoTags(tmp);
    expect(tags).toEqual([]);
  });

  test('github remote → adds github tag', async () => {
    await initGitWithRemote(tmp, 'https://github.com/foo/bar.git');
    const tags = await detectRepoTags(tmp);
    expect(tags).toEqual(['github']);
  });

  test('merges file tags with auto-detected github', async () => {
    await initGitWithRemote(tmp, 'git@github.com:foo/bar.git');
    await mkdir(join(tmp, '.kookr'), { recursive: true });
    await writeFile(join(tmp, '.kookr', 'repo-tags'), 'oss\n');
    const tags = await detectRepoTags(tmp);
    expect(tags.sort()).toEqual(['github', 'oss']);
  });
});

/**
 * Initialize an empty git repo at `dir` and set `remote.origin.url`.
 * Uses `git config` rather than `git remote add` because some user
 * environments (init templates, system gitconfig) pre-create an origin
 * on `git init`, which makes `git remote add origin` fail with EEXIST.
 */
async function initGitWithRemote(dir: string, url: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  await exec('git', ['-C', dir, 'init', '-q']);
  await exec('git', ['-C', dir, 'config', 'remote.origin.url', url]);
}
