// Tests for scripts/nb-backup.sh, the daily job that commits stragglers in the
// notebook store and pushes it. Covered: the NB_DIR resolution and the lock.
// Every run uses a private lock (NB_BACKUP_LOCK), so a test never holds the
// host-wide /tmp/kookr-nb-backup.lock and never makes the real daily backup skip.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanEnv, git } from './lib/nb-test-helpers';

const SCRIPT = join(process.cwd(), 'scripts/nb-backup.sh');
const HAS_FLOCK = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf-8' }).status === 0;

let home: string; // a fake home directory
let cwd: string; // where the script runs, so a literal `~` directory would show up here
let lock: string; // this test's private lock file
let store: string; // the notebook store, at ~/store
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kookr-nb-backup-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'kookr-nb-backup-cwd-'));
  lock = join(home, 'nb-backup.lock');
  store = join(home, 'store');
  mkdirSync(store);
  git(store, 'init', '-q');
  git(store, 'config', 'user.email', 'nb@test');
  git(store, 'config', 'user.name', 'nb test');
  writeFileSync(join(store, '.gitignore'), '.nb-backup.log*\n');
  writeFileSync(join(store, 'patcher.md'), '+1\ta lesson\n');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** Run the backup script (optionally under a wrapper command) with NB_DIR=~/store and the private lock. */
function runBackup(wrapper: string[] = []) {
  const [cmd, ...args] = [...wrapper, 'bash', SCRIPT];
  return spawnSync(cmd, args, {
    cwd,
    env: cleanEnv({ HOME: home, NB_DIR: '~/store', NB_BACKUP_LOCK: lock }),
    encoding: 'utf-8',
  });
}

const readLog = () => readFileSync(join(store, '.nb-backup.log'), 'utf-8');

describe('nb-backup.sh — NB_DIR resolution', () => {
  test('NB_DIR=~/store, passed unexpanded, is the store under the home directory (issue #3673 item 4)', () => {
    const r = runBackup();
    expect(r.stderr).not.toContain('not a git repo');
    expect(r.status).toBe(0); // no remote: the commits stay local and the job succeeds
    // The log is written in the store itself, and the private lock means no other run can make this one skip.
    expect(readLog()).toContain('committed straggler changes');
    expect(git(store, 'log', '--format=%s')).toMatch(/^nb-backup \d{4}-\d{2}-\d{2}$/);
    expect(existsSync(join(cwd, '~'))).toBe(false);
  });
});

describe('nb-backup.sh — lock (issue #3839)', () => {
  test.skipIf(!HAS_FLOCK)('NB_BACKUP_LOCK chooses the lock: a run while that lock is held skips', () => {
    // `flock <lock> <cmd>` holds the lock while the script runs, as a concurrent backup would.
    const r = runBackup(['flock', lock]);
    expect(r.status).toBe(0);
    expect(readLog()).toContain('another nb-backup run is in progress; skipping');
    expect(git(store, 'status', '--porcelain')).not.toBe(''); // nothing was committed
  });
});
