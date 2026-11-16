import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  autoSyncCheckoutForManualLaunch,
  findPlaybooksMissingFromCheckout,
  inspectPlaybookCheckoutDrift,
} from './checkout-auto-sync.js';

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: cleanGitEnv() });
}

/** Read-only git query, same env-stripping as `git()` — a leaked GIT_DIR/GIT_WORK_TREE
 * from a concurrent test in the same worker must never redirect an assertion's
 * `git rev-parse`/`status` onto the ambient repo instead of the mkdtemp one. */
function gitOutput(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanGitEnv() }).toString().trim();
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
      const originHead = gitOutput(remoteDir, 'rev-parse', 'HEAD');

      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result).toEqual({ attempted: true, synced: true });
      const cloneHead = gitOutput(cloneDir, 'rev-parse', 'HEAD');
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

      const headBefore = gitOutput(cloneDir, 'rev-parse', 'HEAD');
      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result.attempted).toBe(false);
      expect(result.synced).toBe(false);
      expect(result.warning).toContain('uncommitted changes');
      const headAfter = gitOutput(cloneDir, 'rev-parse', 'HEAD');
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
      const head = gitOutput(cloneDir, 'rev-parse', 'HEAD');
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
      const headBefore = gitOutput(cloneDir, 'rev-parse', 'HEAD');

      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result.attempted).toBe(true);
      expect(result.synced).toBe(false);
      expect(result.warning).toContain('git pull --rebase');
      const headAfter = gitOutput(cloneDir, 'rev-parse', 'HEAD');
      expect(headAfter).toBe(headBefore);
      const status = gitOutput(cloneDir, 'status', '--porcelain');
      expect(status).toBe(''); // rebase --abort left the tree clean
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
      const headBefore = gitOutput(cloneDir, 'rev-parse', 'HEAD');
      // Point origin at a path with no git repository so `git fetch` itself
      // fails deterministically, before `git pull --rebase` is ever reached.
      git(cloneDir, 'remote', 'set-url', 'origin', join(workDir, 'does-not-exist'));

      const result = await autoSyncCheckoutForManualLaunch(cloneDir);

      expect(result.attempted).toBe(true);
      expect(result.synced).toBe(false);
      expect(result.warning).toContain('git fetch origin');
      expect(result.warning).not.toContain('git pull --rebase');
      const headAfter = gitOutput(cloneDir, 'rev-parse', 'HEAD');
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
      const originHead = gitOutput(remoteDir, 'rev-parse', 'HEAD');

      // Two "manual launches into the same project" firing close together
      // must never race their own `git fetch`/`pull --rebase` on one working
      // tree — they coalesce onto the same in-flight sync.
      const [first, second] = await Promise.all([
        autoSyncCheckoutForManualLaunch(cloneDir),
        autoSyncCheckoutForManualLaunch(cloneDir),
      ]);

      expect(first).toBe(second); // same in-flight promise, not two independent syncs
      expect(first).toEqual({ attempted: true, synced: true });
      const cloneHead = gitOutput(cloneDir, 'rev-parse', 'HEAD');
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

describe('inspectPlaybookCheckoutDrift (issue #2945)', () => {
  const playbookRel = '.kookr/playbooks/workflow.md';

  async function writePlaybook(repoDir: string, body: string) {
    await mkdir(join(repoDir, '.kookr', 'playbooks'), { recursive: true });
    await writeFile(join(repoDir, playbookRel), body);
  }

  it('returns null when cwd is not a git worktree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-nongit-'));
    try {
      await writePlaybook(dir, '# not a git repo\n');
      expect(await inspectPlaybookCheckoutDrift(dir, playbookRel)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a current checkout as not drifted, with no warning', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'drift-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'drift-'));
    try {
      await initGitRepo(remoteDir);
      await writePlaybook(remoteDir, '# playbook v1\n');
      git(remoteDir, 'add', playbookRel);
      git(remoteDir, 'commit', '-m', 'add playbook');
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      const head = gitOutput(cloneDir, 'rev-parse', 'HEAD');

      const result = await inspectPlaybookCheckoutDrift(cloneDir, playbookRel);

      expect(result).toEqual({
        ref: head,
        upstreamRef: 'origin/main',
        behindBy: 0,
        drifted: false,
        blobDiffers: false,
      });
      expect(result?.warning).toBeUndefined();
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('warns when HEAD is behind upstream on the playbook path', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'drift-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'drift-'));
    try {
      await initGitRepo(remoteDir);
      await writePlaybook(remoteDir, '# playbook v1\n');
      git(remoteDir, 'add', playbookRel);
      git(remoteDir, 'commit', '-m', 'add playbook');
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      const staleHead = gitOutput(cloneDir, 'rev-parse', 'HEAD');

      await writePlaybook(remoteDir, '# playbook v2 — drain-floor moved to config\n');
      git(remoteDir, 'add', playbookRel);
      git(remoteDir, 'commit', '-m', 'fix playbook');

      const result = await inspectPlaybookCheckoutDrift(cloneDir, playbookRel);

      expect(result).not.toBeNull();
      expect(result!.ref).toBe(staleHead);
      expect(result!.upstreamRef).toBe('origin/main');
      expect(result!.behindBy).toBe(1);
      expect(result!.drifted).toBe(true);
      expect(result!.blobDiffers).toBe(true);
      expect(result!.warning).toContain('lags its upstream');
      expect(result!.warning).toContain(playbookRel);
      expect(result!.warning).toContain('does not block the run');
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('warns when the checkout is behind even if the playbook blob currently matches', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'drift-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'drift-'));
    try {
      await initGitRepo(remoteDir);
      await writePlaybook(remoteDir, '# playbook v1\n');
      git(remoteDir, 'add', playbookRel);
      git(remoteDir, 'commit', '-m', 'add playbook');
      const cloneDir = await cloneAndTrack(remoteDir, workDir);

      await writeFile(join(remoteDir, 'UNRELATED.md'), 'other\n');
      git(remoteDir, 'add', 'UNRELATED.md');
      git(remoteDir, 'commit', '-m', 'unrelated advance');

      const result = await inspectPlaybookCheckoutDrift(cloneDir, playbookRel);

      expect(result).not.toBeNull();
      expect(result!.behindBy).toBe(1);
      expect(result!.blobDiffers).toBe(false);
      expect(result!.drifted).toBe(true);
      expect(result!.warning).toContain('currently matches upstream');
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe('findPlaybooksMissingFromCheckout (issue #3764)', () => {
  async function addPlaybooks(repoDir: string, names: string[]) {
    await mkdir(join(repoDir, '.kookr', 'playbooks'), { recursive: true });
    for (const name of names) {
      await writeFile(join(repoDir, '.kookr', 'playbooks', name), `# ${name}\n`);
    }
    git(repoDir, 'add', '.kookr');
    git(repoDir, 'commit', '-m', `add ${names.join(', ')}`);
  }

  it('returns null for a directory that is not a git worktree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'missing-nongit-'));
    try {
      await mkdir(join(dir, '.kookr', 'playbooks'), { recursive: true });
      expect(await findPlaybooksMissingFromCheckout(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a path that does not exist', async () => {
    expect(await findPlaybooksMissingFromCheckout(join(tmpdir(), 'missing-does-not-exist-3764'))).toBeNull();
  });

  it('returns null for a git repo with no remote default branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'missing-noremote-'));
    try {
      await initGitRepo(dir);
      await addPlaybooks(dir, ['local.md']);
      expect(await findPlaybooksMissingFromCheckout(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a checkout that has every default-branch playbook', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'missing-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'missing-'));
    try {
      await initGitRepo(remoteDir);
      await addPlaybooks(remoteDir, ['a.md', 'b.md']);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      expect(await findPlaybooksMissingFromCheckout(cloneDir)).toBeNull();
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('reports playbooks merged to the default branch that a no-upstream feature branch lacks', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'missing-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'missing-'));
    try {
      await initGitRepo(remoteDir);
      await addPlaybooks(remoteDir, ['old.md']);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      // Park the checkout on a feature branch with no upstream, as in the issue.
      git(cloneDir, 'switch', '-c', 'feat-old');

      // Merge two playbooks (and a non-playbook file, and a nested file that
      // discovery would not list) to origin's default branch, then fetch.
      await addPlaybooks(remoteDir, ['nb-janitor.md', 'agent-notebook-reflection.md']);
      await writeFile(join(remoteDir, '.kookr', 'playbooks', 'README.txt'), 'not a playbook\n');
      await mkdir(join(remoteDir, '.kookr', 'playbooks', 'nested'), { recursive: true });
      await writeFile(join(remoteDir, '.kookr', 'playbooks', 'nested', 'deep.md'), '# deep\n');
      git(remoteDir, 'add', '.kookr');
      git(remoteDir, 'commit', '-m', 'extra files');
      git(cloneDir, 'fetch', 'origin');
      // Precondition: the feature branch really has no upstream.
      expect(() => gitOutput(cloneDir, 'rev-parse', '--abbrev-ref', 'feat-old@{u}')).toThrow();

      const result = await findPlaybooksMissingFromCheckout(cloneDir);

      expect(result).toEqual({
        defaultBranchRef: 'origin/main',
        checkoutBranch: 'feat-old',
        missing: ['agent-notebook-reflection.md', 'nb-janitor.md'],
      });
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('compares the working tree, not HEAD: a playbook file present on disk is not reported', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'missing-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'missing-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      await addPlaybooks(remoteDir, ['copied.md', 'absent.md']);
      git(cloneDir, 'fetch', 'origin');
      await mkdir(join(cloneDir, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cloneDir, '.kookr', 'playbooks', 'copied.md'), '# untracked copy\n');

      const result = await findPlaybooksMissingFromCheckout(cloneDir);

      expect(result?.missing).toEqual(['absent.md']);
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('omits the branch on a detached HEAD', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'missing-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'missing-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      git(cloneDir, 'switch', '--detach', 'HEAD');
      await addPlaybooks(remoteDir, ['new.md']);
      git(cloneDir, 'fetch', 'origin');

      const result = await findPlaybooksMissingFromCheckout(cloneDir);

      expect(result).toEqual({ defaultBranchRef: 'origin/main', missing: ['new.md'] });
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('uses the last-fetched ref and never reaches the network: an unreachable origin changes nothing', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'missing-origin-'));
    const workDir = await mkdtemp(join(tmpdir(), 'missing-'));
    try {
      await initGitRepo(remoteDir);
      const cloneDir = await cloneAndTrack(remoteDir, workDir);
      await addPlaybooks(remoteDir, ['fetched.md']);
      git(cloneDir, 'fetch', 'origin');
      // A playbook merged after the last fetch is not known yet...
      await addPlaybooks(remoteDir, ['unfetched.md']);
      // ...and the origin then becomes unreachable.
      git(cloneDir, 'remote', 'set-url', 'origin', join(workDir, 'gone.git'));

      const started = Date.now();
      const result = await findPlaybooksMissingFromCheckout(cloneDir);

      expect(result?.missing).toEqual(['fetched.md']);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
