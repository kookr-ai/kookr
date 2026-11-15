import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readIntegrationBranch } from './delivery-gate-config.js';
import { parseIntegrationBranch } from './integration-branch.js';

describe('parseIntegrationBranch (#3797)', () => {
  it.each([
    ['{"integrationBranch":"staging"}', 'staging'],
    ['{"integrationBranch":"release/next"}', 'release/next'],
    ['{"integrationBranch":"main"}', null],
    ['{"integrationBranch":"--evil"}', null],
    ['{"integrationBranch":"a..b"}', null],
    ['{"integrationBranch":"a b"}', null],
    ['{"integrationBranch":""}', null],
    ['{"integrationBranch":3}', null],
    ['{"prePushGate":"fast"}', null],
    ['null', null],
    ['not json', null],
  ])('%s -> %s', (json, expected) => {
    expect(parseIntegrationBranch(json)).toBe(expected);
  });
});

describe('readIntegrationBranch (#3797)', () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  const writeConfig = (json: string) => {
    mkdirSync(path.join(dir, '.kookr'), { recursive: true });
    writeFileSync(path.join(dir, '.kookr', 'delivery-gate.json'), json);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'delivery-gate-config-'));
    git('init', '-q', '-b', 'feature');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'root');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is null with no config (the legacy behaviour)', async () => {
    await expect(readIntegrationBranch(dir)).resolves.toBeNull();
  });

  it('is null outside a git repository', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'delivery-gate-plain-'));
    try {
      await expect(readIntegrationBranch(plain)).resolves.toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('reads the working tree when origin/main does not exist', async () => {
    writeConfig('{"integrationBranch":"staging"}');
    await expect(readIntegrationBranch(dir)).resolves.toBe('staging');
    await expect(readIntegrationBranch(path.join(dir, '.kookr'))).resolves.toBe('staging');
  });

  it('prefers the origin/main copy over the working tree, including its absence', async () => {
    writeConfig('{"integrationBranch":"staging"}');
    git('add', '.kookr/delivery-gate.json');
    git('commit', '-q', '-m', 'config');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await expect(readIntegrationBranch(dir)).resolves.toBe('staging');

    // A worktree cut before the file was reverted on main still sees the revert.
    git('rm', '-q', '.kookr/delivery-gate.json');
    git('commit', '-q', '-m', 'revert config');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeConfig('{"integrationBranch":"staging"}');
    await expect(readIntegrationBranch(dir)).resolves.toBeNull();
  });
});
