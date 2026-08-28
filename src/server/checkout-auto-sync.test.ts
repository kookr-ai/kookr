import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { autoSyncCheckoutForManualLaunch } from './checkout-auto-sync.js';

function git(cwd: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  execFileSync('git', args, { cwd, stdio: 'pipe', env });
}

async function initGitRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  await writeFile(join(dir, 'README.md'), '# test\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'branch', '-M', 'main');
}

/** Clone `repoDir` from `remoteDir` and configure `main` to track `origin/main`. */
async function cloneAndTrack(remoteDir: string, cloneParent: string): Promise<string> {
  const cloneDir = join(cloneParent, 'clone');
  git(cloneParent, 'clone', remoteDir, cloneDir);
  git(cloneDir, 'branch', '-M', 'main');
  git(cloneDir, 'branch', '--set-upstream-to=origin/main', 'main');
  return cloneDir;
}

describe('autoSyncCheckoutForManualLaunch', () => {
  it('fetches and rebases a clean, behind-origin checkout onto the latest origin commit', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'autosync-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'autosync-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);

      // Advance origin past the clone's HEAD.
      await writeFile(join(remoteDir, 'NEW.md'), 'new\n');
      git(remoteDir, 'add', 'NEW.md');
      git(remoteDir, 'commit', '-m', 'advance origin');
      const originHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remoteDir }).toString().trim();

      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result).toEqual({ attempted: true, synced: true });
      const cloneHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();
      expect(cloneHead).toBe(originHead);
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('leaves a dirty checkout untouched and reports why', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'autosync-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'autosync-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      await writeFile(join(cloneDir, 'README.md'), 'dirty\n');

      const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();
      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result.attempted).toBe(false);
      expect(result.synced).toBe(false);
      expect(result.warning).toContain('uncommitted changes');
      const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();
      expect(headAfter).toBe(headBefore);
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('is a no-op on a detached HEAD', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'autosync-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'autosync-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();
      git(cloneDir, 'checkout', '--detach', head);

      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result).toEqual({ attempted: false, synced: false });
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('aborts a failed rebase and leaves the checkout at its previous commit', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'autosync-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'autosync-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);

      // Diverge origin and the clone's committed HEAD on the same line so the
      // rebase conflicts, without leaving the working tree dirty.
      await writeFile(join(remoteDir, 'README.md'), '# remote change\n');
      git(remoteDir, 'add', 'README.md');
      git(remoteDir, 'commit', '-m', 'remote edits README');
      await writeFile(join(cloneDir, 'README.md'), '# local change\n');
      git(cloneDir, 'add', 'README.md');
      git(cloneDir, 'commit', '-m', 'local edits README');
      const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();

      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result.attempted).toBe(true);
      expect(result.synced).toBe(false);
      expect(result.warning).toContain('git pull --rebase');
      const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();
      expect(headAfter).toBe(headBefore);
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: cloneDir }).toString();
      expect(status.trim()).toBe(''); // rebase --abort left the tree clean
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('reports a fetch failure directly, distinct from a rebase failure', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'autosync-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'autosync-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();
      // Point origin at a path with no git repository so `git fetch` itself
      // fails deterministically, before `git pull --rebase` is ever reached.
      git(cloneDir, 'remote', 'set-url', 'origin', join(workDir, 'does-not-exist'));

      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result.attempted).toBe(true);
      expect(result.synced).toBe(false);
      expect(result.warning).toContain('git fetch origin');
      expect(result.warning).not.toContain('git pull --rebase');
      const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();
      expect(headAfter).toBe(headBefore);
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('coalesces concurrent calls for the same checkout onto a single sync', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'autosync-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'autosync-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      await writeFile(join(remoteDir, 'NEW.md'), 'new\n');
      git(remoteDir, 'add', 'NEW.md');
      git(remoteDir, 'commit', '-m', 'advance origin');
      const originHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remoteDir }).toString().trim();

      // Two "manual launches into the same project" firing close together
      // must never race their own `git fetch`/`pull --rebase` on one working
      // tree — they coalesce onto the same in-flight sync.
      const [first, second] = await Promise.all([
        autoSyncCheckoutForManualLaunch(cloneDir),
        autoSyncCheckoutForManualLaunch(cloneDir),
      ]);

      expect(first).toBe(second); // same in-flight promise, not two independent syncs
      expect(first).toEqual({ attempted: true, synced: true });
      const cloneHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir }).toString().trim();
      expect(cloneHead).toBe(originHead);

      // A later call is a fresh sync (the in-flight entry cleared once settled),
      // not stuck forever reusing the first promise.
      const third = await autoSyncCheckoutForManualLaunch(cloneDir);
      expect(third).not.toBe(first);
      expect(third).toEqual({ attempted: true, synced: true }); // already up to date
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
