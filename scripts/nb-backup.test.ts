// Tests for scripts/nb-backup.sh, the daily job that commits stragglers in the
// notebook store and pushes it. Only the NB_DIR resolution is covered here.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'scripts/nb-backup.sh');

/** The environment without the GIT_* variables a git hook exports, which would override `git -C`. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  delete env.NB_DIR;
  return { ...env, ...extra };
}

let home: string; // a fake home directory
let cwd: string; // where the script runs, so a literal `~` directory would show up here
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kookr-nb-backup-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'kookr-nb-backup-cwd-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('nb-backup.sh — NB_DIR resolution', () => {
  test('NB_DIR=~/store, passed unexpanded, is the store under the home directory (issue #3673 item 4)', () => {
    const store = join(home, 'store');
    mkdirSync(store);
    const git = (...args: string[]) => execFileSync('git', ['-C', store, ...args], { env: cleanEnv({}), encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'nb@test');
    git('config', 'user.name', 'nb test');
    writeFileSync(join(store, '.gitignore'), '.nb-backup.log*\n');
    writeFileSync(join(store, 'patcher.md'), '+1\ta lesson\n');

    const r = spawnSync('bash', [SCRIPT], { cwd, env: cleanEnv({ HOME: home, NB_DIR: '~/store' }), encoding: 'utf-8' });
    expect(r.stderr).not.toContain('not a git repo');
    expect(r.status).toBe(0); // no remote: the commits stay local and the job succeeds
    // The log is written in the store itself. Another run holding the shared lock makes
    // this run skip, but it still logs that it did, in the same place.
    const log = readFileSync(join(store, '.nb-backup.log'), 'utf-8');
    expect(log).toMatch(/committed straggler changes|another nb-backup run is in progress/);
    expect(existsSync(join(cwd, '~'))).toBe(false);
  });
});
