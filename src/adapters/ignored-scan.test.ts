import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanIgnored, REGENERABLE_IGNORED_ALLOWLIST } from './ignored-scan.js';

// Strip repo-redirecting git vars (set while a git hook runs `pnpm test`) so
// `git -C <tmp>` operates on the fixture, not the real repo. See the matching
// note in worktree-footprint.test.ts.
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

describe('scanIgnored', () => {
  let root: string;
  let mainRepo: string;
  let worktreePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ignored-scan-'));
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

  test('reports no sensitive ignored paths when only node_modules/ is ignored', async () => {
    await writeFile(join(worktreePath, '.gitignore'), 'node_modules/\n');
    await mkdir(join(worktreePath, 'node_modules', 'some-pkg'), { recursive: true });
    await writeFile(join(worktreePath, 'node_modules', 'some-pkg', 'index.js'), '// stub\n');

    const result = await scanIgnored(worktreePath);

    expect(result.hasSensitiveIgnored).toBe(false);
  });

  test('flags a sensitive ignored .env file and includes it in the sample', async () => {
    await writeFile(join(worktreePath, '.gitignore'), 'node_modules/\n.env\n');
    await mkdir(join(worktreePath, 'node_modules', 'some-pkg'), { recursive: true });
    await writeFile(join(worktreePath, 'node_modules', 'some-pkg', 'index.js'), '// stub\n');
    await writeFile(join(worktreePath, '.env'), 'SECRET=1\n');

    const result = await scanIgnored(worktreePath);

    expect(result.hasSensitiveIgnored).toBe(true);
    expect(result.sample).toContain('.env');
  });

  test('resolves to an empty result for a non-existent path instead of throwing', async () => {
    const result = await scanIgnored('/definitely/does/not/exist/xyz');
    expect(result).toEqual({ hasSensitiveIgnored: false, sample: [] });
  });

  test('exports the expected allowlist entries', () => {
    expect(REGENERABLE_IGNORED_ALLOWLIST).toEqual([
      'node_modules/',
      'dist/',
      'build/',
      'target/',
      '.next/',
      'graphify-out/',
    ]);
  });
});
