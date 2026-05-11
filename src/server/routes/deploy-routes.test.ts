import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { chmod, mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerDeployRoutes, resolveProdDir } from './deploy-routes.js';
import type { RouteDeps } from './shared.js';
import type { WorktreeEntry } from '../../adapters/git-worktree-registry.js';

/** Strip GIT_DIR so git subprocesses work in test dirs, not the repo. */
const cleanEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

function makeApp(serverCwd: string, serverPort: number = 4800, hookHomeDir?: string): Hono {
  const app = new Hono();
  registerDeployRoutes(app, { serverCwd, serverPort, hookHomeDir } as unknown as RouteDeps);
  return app;
}

async function writeInstallHooksFixture(repoDir: string): Promise<void> {
  await mkdir(join(repoDir, 'scripts'), { recursive: true });
  await mkdir(join(repoDir, 'hooks'), { recursive: true });
  await mkdir(join(repoDir, 'plugin', 'skills', 'pre-pr-review'), { recursive: true });
  await writeFile(join(repoDir, 'hooks', 'pr-workflow-gate.sh'), '#!/usr/bin/env bash\n');
  const script = join(repoDir, 'scripts', 'install-hooks.sh');
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
if [ "\${1:-}" = "--print-global-assets" ]; then
  printf '%s\\t%s\\t%s\\n' 'pr-workflow-gate.sh' 'hooks/pr-workflow-gate.sh' '.claude/hooks/pr-workflow-gate.sh'
  printf '%s\\t%s\\t%s\\n' 'pre-pr-review' 'plugin/skills/pre-pr-review' '.claude/skills/pre-pr-review'
  exit 0
fi
install_link() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "Refusing to overwrite non-symlink at $dest. Move it aside and re-run." >&2
    return 1
  fi
  ln -sfn "$src" "$dest"
}
install_link "$REPO_DIR/hooks/pr-workflow-gate.sh" "$HOME/.claude/hooks/pr-workflow-gate.sh"
install_link "$REPO_DIR/plugin/skills/pre-pr-review" "$HOME/.claude/skills/pre-pr-review"
`);
  await chmod(script, 0o755);
}

describe('deploy-routes', () => {
  let root: string;
  let mainDir: string;  // simulates ~/git/kookr
  let prodDir: string;  // simulates ~/git/kookr-prod

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'deploy-test-'));
    mainDir = join(root, 'kookr');
    prodDir = join(root, 'kookr-prod');
    await mkdir(mainDir, { recursive: true });
    // prodDir created per test
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('GET /api/deploy/status', () => {
    it('returns configured:false when prod dir does not exist', async () => {
      // No kookr-prod sibling exists
      const app = makeApp(mainDir);
      const res = await app.request('/api/deploy/status');
      const body = await res.json();
      expect(body.configured).toBe(false);
      expect(body.runningPort).toBe(4800);
      expect(body.prodPort).toBe(4800);
    });

    it('reports the dev runningPort separately from prodPort so the dashboard can detect non-prod servers', async () => {
      // Dev server (4801) with no prod dir configured — the response must
      // still surface both ports so the TopBar can hide the deploy button.
      const app = makeApp(mainDir, 4801);
      const res = await app.request('/api/deploy/status');
      const body = await res.json();
      expect(body.runningPort).toBe(4801);
      expect(body.prodPort).toBe(4800);
    });

    it('returns available:false when prod is up to date', async () => {
      const originDir = join(root, 'origin.git');
      await mkdir(originDir);
      execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: originDir, env: cleanEnv });

      execFileSync('git', ['clone', originDir, prodDir], { env: cleanEnv });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: prodDir, env: cleanEnv });

      await writeFile(join(prodDir, 'README.md'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['push'], { cwd: prodDir, env: cleanEnv });
      await writeInstallHooksFixture(prodDir);

      const app = makeApp(mainDir);
      const res = await app.request('/api/deploy/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configured).toBe(true);
      expect(body.available).toBe(false);
      expect(body.behindCount).toBe(0);
      expect(body.commits).toEqual([]);
    });

    it('returns available:true with commit list when behind origin/main', async () => {
      const originDir = join(root, 'origin.git');
      await mkdir(originDir);
      execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: originDir, env: cleanEnv });

      // Clone into prod
      execFileSync('git', ['clone', originDir, prodDir], { env: cleanEnv });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: prodDir, env: cleanEnv });

      await writeFile(join(prodDir, 'README.md'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['push'], { cwd: prodDir, env: cleanEnv });

      // Push 2 new commits from a "dev" clone
      const devDir = join(root, 'dev');
      execFileSync('git', ['clone', originDir, devDir], { env: cleanEnv });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: devDir, env: cleanEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: devDir, env: cleanEnv });

      await writeFile(join(devDir, 'a.txt'), 'aaa');
      execFileSync('git', ['add', '.'], { cwd: devDir, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'feat: add feature A'], { cwd: devDir, env: cleanEnv });

      await writeFile(join(devDir, 'b.txt'), 'bbb');
      execFileSync('git', ['add', '.'], { cwd: devDir, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'fix: fix bug B'], { cwd: devDir, env: cleanEnv });
      execFileSync('git', ['push'], { cwd: devDir, env: cleanEnv });

      const app = makeApp(mainDir);
      const res = await app.request('/api/deploy/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configured).toBe(true);
      expect(body.available).toBe(true);
      expect(body.behindCount).toBe(2);
      expect(body.commits).toHaveLength(2);
      expect(body.commits[0].subject).toBe('fix: fix bug B');
      expect(body.commits[1].subject).toBe('feat: add feature A');
    });

    it('surfaces stale toolkit symlinks against the production worktree', async () => {
      const originDir = join(root, 'origin.git');
      const oldDir = join(root, 'kookr-old');
      const hookHome = join(root, 'home');
      await mkdir(originDir);
      execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: originDir, env: cleanEnv });
      execFileSync('git', ['clone', originDir, prodDir], { env: cleanEnv });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: prodDir, env: cleanEnv });
      await writeFile(join(prodDir, 'README.md'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['push'], { cwd: prodDir, env: cleanEnv });

      await mkdir(join(oldDir, 'hooks'), { recursive: true });
      await mkdir(join(oldDir, 'plugin', 'skills', 'pre-pr-review'), { recursive: true });
      await writeInstallHooksFixture(prodDir);
      await mkdir(join(hookHome, '.claude', 'hooks'), { recursive: true });
      await mkdir(join(hookHome, '.claude', 'skills'), { recursive: true });
      await symlink(join(oldDir, 'hooks', 'pr-workflow-gate.sh'), join(hookHome, '.claude', 'hooks', 'pr-workflow-gate.sh'));
      await symlink(join(oldDir, 'plugin', 'skills', 'pre-pr-review'), join(hookHome, '.claude', 'skills', 'pre-pr-review'));

      const app = makeApp(mainDir, 4800, hookHome);
      const res = await app.request('/api/deploy/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.toolkit.stale).toBe(true);
      expect(body.toolkit.staleCount).toBe(2);
    });

    it('returns local toolkit status even when git freshness fails', async () => {
      await mkdir(prodDir, { recursive: true });
      await writeInstallHooksFixture(prodDir);
      const hookHome = join(root, 'home');

      const app = makeApp(mainDir, 4800, hookHome);
      const res = await app.request('/api/deploy/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configured).toBe(true);
      expect(body.error).toMatch(/git/);
      expect(body.toolkit.stale).toBe(true);
      expect(body.toolkit.staleCount).toBe(2);
    });
  });

  describe('POST /api/deploy/trigger', () => {
    it('prod-update script detaches kookr-prod to origin/main before build', () => {
      const script = readFileSync(join(process.cwd(), 'scripts', 'prod-update.sh'), 'utf-8');
      expect(script).toContain('git switch --detach origin/main');
    });

    it('prod-update script links the main checkout .env into kookr-prod', () => {
      const script = readFileSync(join(process.cwd(), 'scripts', 'prod-update.sh'), 'utf-8');
      expect(script).toContain('ln -sfn "${ROOT_DIR}/.env" "${PROD_DIR}/.env"');
    });

    it('prod:setup mirrors the production .env symlink step', () => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts['prod:setup']).toContain('ln -sfn "$(pwd)/.env" ../kookr-prod/.env');
    });

    it('install-hooks publishes pre-pr-review from the toolkit plugin tree', () => {
      const output = execFileSync('bash', ['scripts/install-hooks.sh', '--print-global-assets'], {
        cwd: process.cwd(),
        env: cleanEnv,
        encoding: 'utf-8',
      });
      expect(output).toContain('plugin/skills/pre-pr-review\t.claude/skills/pre-pr-review');
      expect(output).not.toContain('.claude/skills/pre-pr-review\t.claude/skills/pre-pr-review');
    });

    it('returns 400 when prod dir does not exist', async () => {
      const app = makeApp(mainDir);
      const res = await app.request('/api/deploy/trigger', { method: 'POST' });
      expect(res.status).toBe(400);
    });

    it('returns 409 when already deploying', async () => {
      await mkdir(prodDir, { recursive: true });
      const app = makeApp(mainDir);

      const res1 = await app.request('/api/deploy/trigger', { method: 'POST' });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.status).toBe('deploying');

      const res2 = await app.request('/api/deploy/trigger', { method: 'POST' });
      expect(res2.status).toBe(409);
    });
  });

  describe('POST /api/deploy/toolkit-refresh', () => {
    it('refreshes stale toolkit links through the install-hooks script', async () => {
      await mkdir(prodDir, { recursive: true });
      await writeInstallHooksFixture(prodDir);
      const hookHome = join(root, 'home');
      const oldRoot = join(root, 'old');
      await mkdir(join(oldRoot, 'hooks'), { recursive: true });
      await mkdir(join(hookHome, '.claude', 'hooks'), { recursive: true });
      await symlink(join(oldRoot, 'hooks', 'pr-workflow-gate.sh'), join(hookHome, '.claude', 'hooks', 'pr-workflow-gate.sh'));
      const app = makeApp(mainDir, 4800, hookHome);

      const res = await app.request('/api/deploy/toolkit-refresh', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('refreshed');
      expect(body.toolkit.stale).toBe(false);
    });

    it('refuses to clobber non-symlink hook files and returns current status', async () => {
      await mkdir(prodDir, { recursive: true });
      await writeInstallHooksFixture(prodDir);
      const hookHome = join(root, 'home');
      await mkdir(join(hookHome, '.claude', 'hooks'), { recursive: true });
      await writeFile(join(hookHome, '.claude', 'hooks', 'pr-workflow-gate.sh'), 'custom');
      const app = makeApp(mainDir, 4800, hookHome);

      const res = await app.request('/api/deploy/toolkit-refresh', { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('Refusing to overwrite non-symlink');
      expect(body.toolkit.stale).toBe(true);
    });
  });

  describe('resolveProdDir', () => {
    function makeEntry(path: string): WorktreeEntry {
      return { path, branch: null, head: 'abc', isDetached: false, isPrunable: false, isMain: false };
    }

    it('falls back to legacy sibling path when no registry is provided', () => {
      const dir = resolveProdDir({ serverCwd: '/home/me/git/kookr' });
      expect(dir).toBe('/home/me/git/kookr-prod');
    });

    it('returns the server cwd when its basename matches the legacy convention', () => {
      const dir = resolveProdDir({ serverCwd: '/home/me/git/kookr-prod' });
      expect(dir).toBe('/home/me/git/kookr-prod');
    });

    it('returns the path of the unique worktree carrying the marker', async () => {
      const prodWt = join(root, 'kookr-runtime');
      await mkdir(prodWt, { recursive: true });
      await writeFile(join(prodWt, '.kookr-protected'), 'production runtime\n');
      const otherWt = join(root, 'kookr-feature');
      await mkdir(otherWt, { recursive: true });

      const dir = resolveProdDir({
        serverCwd: mainDir,
        worktreeRegistry: { all: () => [makeEntry(mainDir), makeEntry(prodWt), makeEntry(otherWt)] },
      });
      expect(dir).toBe(prodWt);
    });

    it('throws when multiple worktrees carry the marker', async () => {
      const wt1 = join(root, 'kookr-prod');
      const wt2 = join(root, 'kookr-runtime');
      await mkdir(wt1, { recursive: true });
      await mkdir(wt2, { recursive: true });
      await writeFile(join(wt1, '.kookr-protected'), 'production runtime\n');
      await writeFile(join(wt2, '.kookr-protected'), 'production runtime\n');

      expect(() =>
        resolveProdDir({
          serverCwd: mainDir,
          worktreeRegistry: { all: () => [makeEntry(wt1), makeEntry(wt2)] },
        }),
      ).toThrow(/multiple .kookr-protected worktrees/);
    });

    it('falls back to legacy resolver when registry has no markers', () => {
      const dir = resolveProdDir({
        serverCwd: mainDir,
        worktreeRegistry: { all: () => [makeEntry(mainDir)] },
      });
      expect(dir).toBe(join(root, 'kookr-prod'));
    });
  });
});
