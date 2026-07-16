import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { access, chmod, mkdtemp, rm, mkdir, readlink, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { registerDeployRoutes, resolveProdDir } from './deploy-routes.js';
import type { DeployRouteDeps } from './shared.js';
import type { WorktreeEntry } from '../../adapters/git-worktree-registry.js';

/** Strip GIT_DIR so git subprocesses work in test dirs, not the repo. */
const cleanEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

function makeApp(serverCwd: string, serverPort: number = 4800, hookHomeDir?: string, pluginUpdateBin?: string): Hono {
  const app = new Hono();
  registerDeployRoutes(app, { serverCwd, serverPort, hookHomeDir, pluginUpdateBin } satisfies DeployRouteDeps);
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
    // Resolve to the physical path so symlink targets (which prod-update.sh
    // stores via realpath) match the paths we build here. On macOS, mkdtemp
    // under tmpdir returns /var/folders/... while realpath returns /private/var/...
    root = realpathSync(await mkdtemp(join(tmpdir(), 'deploy-test-')));
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

    it('flags the marketplace plugin as stale when the installed version is behind origin/main', async () => {
      const originDir = join(root, 'origin.git');
      const hookHome = join(root, 'home');
      await mkdir(originDir);
      execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: originDir, env: cleanEnv });
      execFileSync('git', ['clone', originDir, prodDir], { env: cleanEnv });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: prodDir, env: cleanEnv });

      // Publish the plugin + marketplace manifests to origin/main (the source
      // readPluginVersionStatus reads "available" from).
      await mkdir(join(prodDir, 'plugin', '.claude-plugin'), { recursive: true });
      await mkdir(join(prodDir, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(prodDir, 'plugin', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'kookr-toolkit', version: '0.7.4' }),
      );
      await writeFile(
        join(prodDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ name: 'kookr', plugins: [{ name: 'kookr-toolkit', source: './plugin' }] }),
      );
      execFileSync('git', ['add', '.'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['push'], { cwd: prodDir, env: cleanEnv });
      await writeInstallHooksFixture(prodDir);

      // Installed marketplace copy is behind (0.4.1 < 0.7.4).
      await mkdir(join(hookHome, '.claude', 'plugins'), { recursive: true });
      await writeFile(
        join(hookHome, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { 'kookr-toolkit@kookr': [{ scope: 'user', version: '0.4.1' }] } }),
      );

      const app = makeApp(mainDir, 4800, hookHome);
      const res = await app.request('/api/deploy/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.plugin).toBeDefined();
      expect(body.plugin.pluginId).toBe('kookr-toolkit@kookr');
      expect(body.plugin.installedVersion).toBe('0.4.1');
      expect(body.plugin.availableVersion).toBe('0.7.4');
      expect(body.plugin.stale).toBe(true);
    });

    it('reports the plugin as not-installed (sourced from the server checkout) for a first-time user with no prod tree', async () => {
      // First-time user: no kookr-prod sibling, no marketplace install. The
      // available version must still be resolved from the running server's own
      // checkout (mainDir/serverCwd) so the dashboard can nudge an install.
      await mkdir(join(mainDir, 'plugin', '.claude-plugin'), { recursive: true });
      await writeFile(
        join(mainDir, 'plugin', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'kookr-toolkit', version: '0.7.4' }),
      );
      await mkdir(join(mainDir, '.claude-plugin'), { recursive: true });
      await writeFile(join(mainDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'kookr' }));
      const hookHome = join(root, 'home'); // no installed_plugins.json

      const app = makeApp(mainDir, 4800, hookHome);
      const res = await app.request('/api/deploy/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configured).toBe(false); // no prod tree
      expect(body.plugin).toBeDefined();
      expect(body.plugin.pluginId).toBe('kookr-toolkit@kookr');
      expect(body.plugin.installedVersion).toBeNull();
      expect(body.plugin.availableVersion).toBe('0.7.4');
      expect(body.plugin.stale).toBe(false); // not installed ⇒ not "stale", surfaced as not-installed in the UI
    });
  });

  describe('POST /api/deploy/trigger', () => {
    it('prod-update script detaches kookr-prod to origin/main before build', () => {
      const script = readFileSync(join(process.cwd(), 'scripts', 'prod-update.sh'), 'utf-8');
      expect(script).toContain('git switch --detach origin/main');
    });

    it('prod-update script links the selected env root .env into kookr-prod', () => {
      const script = readFileSync(join(process.cwd(), 'scripts', 'prod-update.sh'), 'utf-8');
      expect(script).toContain('ln -sfn "${ENV_ROOT_DIR}/.env" "${PROD_DIR}/.env"');
    });

    it('prod-update discards tracked local changes in the production worktree before switching', async () => {
      const origin = join(root, 'origin.git');
      const dev = join(root, 'dev');
      const bin = join(root, 'bin');
      await mkdir(origin);
      await mkdir(join(mainDir, 'scripts'), { recursive: true });
      await mkdir(bin, { recursive: true });
      execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: origin, env: cleanEnv });
      execFileSync('git', ['clone', origin, prodDir], { env: cleanEnv });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: prodDir, env: cleanEnv });
      await writeFile(join(prodDir, 'README.md'), 'clean\n', 'utf8');
      execFileSync('git', ['add', 'README.md'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['clone', origin, dev], { env: cleanEnv });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dev, env: cleanEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dev, env: cleanEnv });
      await writeFile(join(dev, 'README.md'), 'updated\n', 'utf8');
      execFileSync('git', ['add', 'README.md'], { cwd: dev, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'update readme'], { cwd: dev, env: cleanEnv });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: dev, env: cleanEnv });
      await writeFile(join(prodDir, 'README.md'), 'dirty\n', 'utf8');
      await writeFile(
        join(mainDir, 'scripts', 'prod-update.sh'),
        readFileSync(join(process.cwd(), 'scripts', 'prod-update.sh'), 'utf8'),
        'utf8',
      );
      await writeFile(join(mainDir, 'scripts', 'prod-restart.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await chmod(join(mainDir, 'scripts', 'prod-update.sh'), 0o755);
      await chmod(join(mainDir, 'scripts', 'prod-restart.sh'), 0o755);
      await chmod(join(bin, 'pnpm'), 0o755);

      const output = execFileSync('bash', [join(mainDir, 'scripts', 'prod-update.sh')], {
        cwd: mainDir,
        env: {
          ...cleanEnv,
          KOOKR_PROD_DIR: prodDir,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      expect(output).toContain('HEAD is now at');
      expect(readFileSync(join(prodDir, 'README.md'), 'utf8')).toBe('updated\n');
      expect(execFileSync('git', ['status', '--short', '--untracked-files=no'], {
        cwd: prodDir,
        env: cleanEnv,
        encoding: 'utf-8',
      })).toBe('');
    });

    it('prod-update keeps the prod .env symlink pointed at the sibling main checkout when run from kookr-prod', async () => {
      const main = join(root, 'kookr');
      const prod = join(root, 'kookr-prod');
      const bin = join(root, 'bin');
      await mkdir(join(main), { recursive: true });
      await mkdir(join(prod, 'scripts'), { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(join(main, '.env'), 'KOOKR_RELAY_ADMIN_TOKEN=main-token\n', 'utf8');
      await writeFile(
        join(prod, 'scripts', 'prod-update.sh'),
        readFileSync(join(process.cwd(), 'scripts', 'prod-update.sh'), 'utf-8'),
        'utf8',
      );
      await writeFile(join(prod, 'scripts', 'prod-restart.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(join(bin, 'git'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await chmod(join(prod, 'scripts', 'prod-update.sh'), 0o755);
      await chmod(join(prod, 'scripts', 'prod-restart.sh'), 0o755);
      await chmod(join(bin, 'git'), 0o755);
      await chmod(join(bin, 'pnpm'), 0o755);

      execFileSync('bash', [join(prod, 'scripts', 'prod-update.sh')], {
        cwd: prod,
        env: {
          ...cleanEnv,
          KOOKR_ENV_ROOT_DIR: undefined,
          KOOKR_PROD_DIR: prod,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      });

      await expect(readlink(join(prod, '.env'))).resolves.toBe(join(main, '.env'));
    });

    it('prod-update honors an explicit env root override for the production .env symlink', async () => {
      const prod = join(root, 'kookr-prod');
      const overrideRoot = join(root, 'config-root');
      const bin = join(root, 'bin');
      await mkdir(join(prod, 'scripts'), { recursive: true });
      await mkdir(overrideRoot, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(join(overrideRoot, '.env'), 'KOOKR_RELAY_ADMIN_TOKEN=override-token\n', 'utf8');
      await writeFile(
        join(prod, 'scripts', 'prod-update.sh'),
        readFileSync(join(process.cwd(), 'scripts', 'prod-update.sh'), 'utf-8'),
        'utf8',
      );
      await writeFile(join(prod, 'scripts', 'prod-restart.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(join(bin, 'git'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await chmod(join(prod, 'scripts', 'prod-update.sh'), 0o755);
      await chmod(join(prod, 'scripts', 'prod-restart.sh'), 0o755);
      await chmod(join(bin, 'git'), 0o755);
      await chmod(join(bin, 'pnpm'), 0o755);

      execFileSync('bash', [join(prod, 'scripts', 'prod-update.sh')], {
        cwd: prod,
        env: {
          ...cleanEnv,
          KOOKR_ENV_ROOT_DIR: overrideRoot,
          KOOKR_PROD_DIR: prod,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      });

      await expect(readlink(join(prod, '.env'))).resolves.toBe(join(overrideRoot, '.env'));
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

  describe('POST /api/deploy/plugin-update', () => {
    async function writePublishedPluginRepo(version: string): Promise<void> {
      const originDir = join(root, 'origin.git');
      await mkdir(originDir);
      execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: originDir, env: cleanEnv });
      execFileSync('git', ['clone', originDir, prodDir], { env: cleanEnv });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: prodDir, env: cleanEnv });
      await mkdir(join(prodDir, 'plugin', '.claude-plugin'), { recursive: true });
      await mkdir(join(prodDir, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(prodDir, 'plugin', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'kookr-toolkit', version }),
      );
      await writeFile(
        join(prodDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ name: 'kookr', plugins: [{ name: 'kookr-toolkit', source: './plugin' }] }),
      );
      execFileSync('git', ['add', '.'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: prodDir, env: cleanEnv });
      execFileSync('git', ['push'], { cwd: prodDir, env: cleanEnv });
      await writeInstallHooksFixture(prodDir);
    }

    async function writeInstalledPlugin(home: string, version: string): Promise<void> {
      await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
      await writeFile(
        join(home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { 'kookr-toolkit@kookr': [{ scope: 'user', version }] } }),
      );
    }

    async function writeFakeClaudeBin(logPath: string, installedVersionAfterUpdate: string): Promise<string> {
      const bin = join(root, 'fake-claude');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "update" ] && [ "$4" = "kookr" ]; then
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "update" ] && [ "$3" = "kookr-toolkit@kookr" ]; then
  node - "$HOME/.claude/plugins/installed_plugins.json" "${installedVersionAfterUpdate}" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const version = process.argv[3];
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
parsed.plugins['kookr-toolkit@kookr'][0].version = version;
fs.writeFileSync(file, JSON.stringify(parsed));
NODE
  exit 0
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      return bin;
    }

    async function writeFailingClaudeBin(logPath: string): Promise<string> {
      const bin = join(root, 'fake-claude-failing');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "update" ]; then
  echo "marketplace update failed" >&2
  exit 17
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      return bin;
    }

    async function writeSlowClaudeBin(logPath: string, installedVersionAfterUpdate: string): Promise<string> {
      const bin = join(root, 'fake-claude-slow');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "update" ] && [ "$4" = "kookr" ]; then
  sleep 0.2
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "update" ] && [ "$3" = "kookr-toolkit@kookr" ]; then
  node - "$HOME/.claude/plugins/installed_plugins.json" "${installedVersionAfterUpdate}" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const version = process.argv[3];
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
parsed.plugins['kookr-toolkit@kookr'][0].version = version;
fs.writeFileSync(file, JSON.stringify(parsed));
NODE
  exit 0
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      return bin;
    }

    it('updates the marketplace cache and then the installed plugin', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writePublishedPluginRepo('0.7.4');
      await writeInstalledPlugin(hookHome, '0.4.1');
      const fakeClaude = await writeFakeClaudeBin(commandLog, '0.7.4');
      const app = makeApp(mainDir, 4800, hookHome, fakeClaude);

      const res = await app.request('/api/deploy/plugin-update', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('updated');
      expect(body.plugin.installedVersion).toBe('0.7.4');
      expect(body.plugin.stale).toBe(false);
      expect(body.commands.slash).toEqual([
        '/plugin marketplace update kookr',
        '/plugin update kookr-toolkit@kookr',
      ]);
      expect(readFileSync(commandLog, 'utf8').trim().split('\n')).toEqual([
        'plugin marketplace update kookr',
        'plugin update kookr-toolkit@kookr',
      ]);
    });

    it('does not try to update when the marketplace plugin is not installed', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writePublishedPluginRepo('0.7.4');
      const fakeClaude = await writeFakeClaudeBin(commandLog, '0.7.4');
      const app = makeApp(mainDir, 4800, hookHome, fakeClaude);

      const res = await app.request('/api/deploy/plugin-update', { method: 'POST' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Toolkit plugin is not installed yet');
      expect(body.plugin.installedVersion).toBeNull();
      expect(() => readFileSync(commandLog, 'utf8')).toThrow();
    });

    it('returns manual commands and current plugin status when the claude command fails', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writePublishedPluginRepo('0.7.4');
      await writeInstalledPlugin(hookHome, '0.4.1');
      const fakeClaude = await writeFailingClaudeBin(commandLog);
      const app = makeApp(mainDir, 4800, hookHome, fakeClaude);

      const res = await app.request('/api/deploy/plugin-update', { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('marketplace update failed');
      expect(body.plugin.installedVersion).toBe('0.4.1');
      expect(body.plugin.stale).toBe(true);
      expect(body.commands.cli).toEqual([
        'claude plugin marketplace update kookr',
        'claude plugin update kookr-toolkit@kookr',
      ]);
      expect(readFileSync(commandLog, 'utf8').trim()).toBe('plugin marketplace update kookr');
    });

    it('serializes concurrent plugin update requests', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writePublishedPluginRepo('0.7.4');
      await writeInstalledPlugin(hookHome, '0.4.1');
      const fakeClaude = await writeSlowClaudeBin(commandLog, '0.7.4');
      const app = makeApp(mainDir, 4800, hookHome, fakeClaude);

      const [first, second] = await Promise.all([
        app.request('/api/deploy/plugin-update', { method: 'POST' }),
        app.request('/api/deploy/plugin-update', { method: 'POST' }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      const rejected = first.status === 409 ? first : second;
      const body = await rejected.json();
      expect(body.error).toBe('Plugin update already in progress');
      expect(readFileSync(commandLog, 'utf8').trim().split('\n')).toEqual([
        'plugin marketplace update kookr',
        'plugin update kookr-toolkit@kookr',
      ]);
    });
  });

  describe('POST /api/deploy/plugin-install', () => {
    /** Write minimal plugin manifests to mainDir so resolveAvailablePlugin can find them on disk. */
    async function writeLocalPluginManifests(version: string): Promise<void> {
      await mkdir(join(mainDir, 'plugin', '.claude-plugin'), { recursive: true });
      await mkdir(join(mainDir, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(mainDir, 'plugin', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'kookr-toolkit', version }),
      );
      await writeFile(
        join(mainDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ name: 'kookr', plugins: [{ name: 'kookr-toolkit', source: './plugin' }] }),
      );
    }

    async function writeInstalledPlugin(home: string, version: string): Promise<void> {
      await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
      await writeFile(
        join(home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { 'kookr-toolkit@kookr': [{ scope: 'user', version }] } }),
      );
    }

    /**
     * A fake claude binary that handles `plugin marketplace add <slug>` and
     * `plugin install <id>` — on `plugin install` it writes an installed_plugins.json
     * to $HOME/.claude/plugins/ so the post-install verification passes.
     */
    async function writeFakeInstallBin(logPath: string, installedVersion: string): Promise<string> {
      const bin = join(root, 'fake-claude-install');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  PLUGINS_DIR="$HOME/.claude/plugins"
  mkdir -p "$PLUGINS_DIR"
  REGISTRY="$PLUGINS_DIR/installed_plugins.json"
  node - "$REGISTRY" "${installedVersion}" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const version = process.argv[3];
let parsed = { version: 2, plugins: {} };
try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!parsed.plugins['kookr-toolkit@kookr']) parsed.plugins['kookr-toolkit@kookr'] = [];
parsed.plugins['kookr-toolkit@kookr'].push({ scope: 'user', version });
fs.writeFileSync(file, JSON.stringify(parsed));
NODE
  exit 0
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      return bin;
    }

    /** A fake claude binary that fails on the first `plugin marketplace add` command. */
    async function writeFailingInstallBin(logPath: string): Promise<string> {
      const bin = join(root, 'fake-claude-install-fail');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then
  echo "marketplace add failed: network error" >&2
  exit 17
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      return bin;
    }

    /** Slow bin for concurrency test (sleeps on marketplace add). */
    async function writeSlowInstallBin(logPath: string, installedVersion: string): Promise<string> {
      const bin = join(root, 'fake-claude-install-slow');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then
  sleep 0.2
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  PLUGINS_DIR="$HOME/.claude/plugins"
  mkdir -p "$PLUGINS_DIR"
  REGISTRY="$PLUGINS_DIR/installed_plugins.json"
  node - "$REGISTRY" "${installedVersion}" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const version = process.argv[3];
let parsed = { version: 2, plugins: {} };
try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!parsed.plugins['kookr-toolkit@kookr']) parsed.plugins['kookr-toolkit@kookr'] = [];
parsed.plugins['kookr-toolkit@kookr'].push({ scope: 'user', version });
fs.writeFileSync(file, JSON.stringify(parsed));
NODE
  exit 0
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      return bin;
    }

    it('installs the marketplace and plugin and returns status installed', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writeLocalPluginManifests('0.7.4');
      const fakeClaude = await writeFakeInstallBin(commandLog, '0.7.4');
      const app = makeApp(mainDir, 4800, hookHome, fakeClaude);

      const res = await app.request('/api/deploy/plugin-install', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('installed');
      expect(body.plugin.installedVersion).toBe('0.7.4');
      expect(body.plugin.stale).toBe(false);
      expect(body.commands.slash).toEqual([
        '/plugin marketplace add kookr-ai/kookr',
        '/plugin install kookr-toolkit@kookr',
      ]);
      expect(readFileSync(commandLog, 'utf8').trim().split('\n')).toEqual([
        'plugin marketplace add kookr-ai/kookr',
        'plugin install kookr-toolkit@kookr',
      ]);
    });

    it('returns 400 when the plugin is already installed', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writeLocalPluginManifests('0.7.4');
      await writeInstalledPlugin(hookHome, '0.7.4');
      const fakeClaude = await writeFakeInstallBin(commandLog, '0.7.4');
      const app = makeApp(mainDir, 4800, hookHome, fakeClaude);

      const res = await app.request('/api/deploy/plugin-install', { method: 'POST' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Toolkit plugin is already installed');
      expect(body.plugin.installedVersion).toBe('0.7.4');
      // No claude commands should have been run
      expect(() => readFileSync(commandLog, 'utf8')).toThrow();
    });

    it('restores the backup and returns 500 with commands when the install command fails', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writeLocalPluginManifests('0.7.4');

      // Pre-existing plugins dir with some config the install shouldn't destroy
      await mkdir(join(hookHome, '.claude', 'plugins'), { recursive: true });
      const existingRegistry = JSON.stringify({
        version: 2,
        plugins: { 'some-other-plugin@other': [{ scope: 'user', version: '1.0.0' }] },
      });
      await writeFile(
        join(hookHome, '.claude', 'plugins', 'installed_plugins.json'),
        existingRegistry,
      );

      const fakeClaude = await writeFailingInstallBin(commandLog);
      const app = makeApp(mainDir, 4800, hookHome, fakeClaude);

      const res = await app.request('/api/deploy/plugin-install', { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('marketplace add failed');
      expect(body.commands.slash).toEqual([
        '/plugin marketplace add kookr-ai/kookr',
        '/plugin install kookr-toolkit@kookr',
      ]);
      // Verify the backup was restored: the registry must still have the original content
      const restoredRegistry = readFileSync(
        join(hookHome, '.claude', 'plugins', 'installed_plugins.json'),
        'utf8',
      );
      expect(JSON.parse(restoredRegistry)).toEqual(JSON.parse(existingRegistry));
    });

    it('returns 409 when a concurrent install is already in progress', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writeLocalPluginManifests('0.7.4');
      const fakeClaude = await writeSlowInstallBin(commandLog, '0.7.4');
      const app = makeApp(mainDir, 4800, hookHome, fakeClaude);

      const [first, second] = await Promise.all([
        app.request('/api/deploy/plugin-install', { method: 'POST' }),
        app.request('/api/deploy/plugin-install', { method: 'POST' }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      const rejected = first.status === 409 ? first : second;
      const body = await rejected.json();
      expect(body.error).toBe('Plugin install already in progress');
    });

    it('restores original installed_plugins.json when marketplace add succeeds but plugin install fails', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writeLocalPluginManifests('0.7.4');

      // Pre-existing plugins dir with a registry entry
      await mkdir(join(hookHome, '.claude', 'plugins'), { recursive: true });
      const existingRegistry = JSON.stringify({
        version: 2,
        plugins: { 'some-other-plugin@other': [{ scope: 'user', version: '2.0.0' }] },
      });
      await writeFile(join(hookHome, '.claude', 'plugins', 'installed_plugins.json'), existingRegistry);

      // Fake claude: marketplace add succeeds, plugin install fails
      const bin = join(root, 'fake-claude-partial-fail');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${commandLog}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  echo "plugin install failed: registry locked" >&2
  exit 17
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      const app = makeApp(mainDir, 4800, hookHome, bin);

      const res = await app.request('/api/deploy/plugin-install', { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('plugin install failed');

      // The original registry must be fully restored
      const restoredRegistry = readFileSync(
        join(hookHome, '.claude', 'plugins', 'installed_plugins.json'),
        'utf8',
      );
      expect(JSON.parse(restoredRegistry)).toEqual(JSON.parse(existingRegistry));
    });

    it('removes plugins dir when it did not exist before and the install fails', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writeLocalPluginManifests('0.7.4');
      // No plugins dir — first-time user

      // Fake claude: marketplace add creates some stray files, plugin install fails
      const bin = join(root, 'fake-claude-stray-fail');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${commandLog}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then
  mkdir -p "$HOME/.claude/plugins/marketplaces/kookr"
  echo '{"name":"kookr"}' > "$HOME/.claude/plugins/known_marketplaces.json"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  echo "plugin install failed: registry locked" >&2
  exit 17
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      const app = makeApp(mainDir, 4800, hookHome, bin);

      const res = await app.request('/api/deploy/plugin-install', { method: 'POST' });
      expect(res.status).toBe(500);

      // ~/.claude/plugins/ must not exist — stray files should be gone
      const pluginsDir = join(hookHome, '.claude', 'plugins');
      await expect(access(pluginsDir)).rejects.toThrow();
    });

    it('returns 500 with backup path in error body when restore rename fails', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writeLocalPluginManifests('0.7.4');

      // Pre-existing plugins dir
      const claudeDir = join(hookHome, '.claude');
      await mkdir(join(claudeDir, 'plugins'), { recursive: true });
      const existingRegistry = JSON.stringify({ version: 2, plugins: {} });
      await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), existingRegistry);

      // Fake claude: marketplace add succeeds, then makes .claude/ non-writable
      // so that the restore rename will fail, then plugin install fails.
      const bin = join(root, 'fake-claude-restore-fail');
      await writeFile(bin, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${commandLog}"
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then
  # Remove write permission from .claude/ so subsequent renames inside it fail
  chmod 555 "${hookHome}/.claude"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  echo "install failed: registry locked" >&2
  exit 17
fi
echo "unexpected claude args: $*" >&2
exit 2
`);
      await chmod(bin, 0o755);
      const app = makeApp(mainDir, 4800, hookHome, bin);

      let res: Response;
      try {
        res = await app.request('/api/deploy/plugin-install', { method: 'POST' });
      } finally {
        // Restore so afterEach rm can clean up
        await chmod(claudeDir, 0o755);
      }

      expect(res!.status).toBe(500);
      const body = await res!.json();
      // Error body must include the backup path so the user can recover
      expect(body.error).toMatch(/kookr-install-backup/);
    });

    it('holding the install lock makes a concurrent plugin-update return 409', async () => {
      const hookHome = join(root, 'home');
      const commandLog = join(root, 'claude-commands.log');
      await writeLocalPluginManifests('0.7.4');
      // slow install to hold the lock
      const slowInstall = await writeSlowInstallBin(commandLog, '0.7.4');
      const app = makeApp(mainDir, 4800, hookHome, slowInstall);

      // Fire install (takes 200ms) and a quick update simultaneously
      const [installRes, updateRes] = await Promise.all([
        app.request('/api/deploy/plugin-install', { method: 'POST' }),
        app.request('/api/deploy/plugin-update', { method: 'POST' }),
      ]);

      // One of them must be 409 (the one that lost the lock race)
      const statuses = [installRes.status, updateRes.status].sort();
      expect(statuses).toContain(409);
      const rejected = updateRes.status === 409 ? updateRes : installRes;
      const body = await rejected.json();
      expect(body.error).toMatch(/already in progress/);
    });
  });

  describe('resolveProdDir', () => {
    function makeEntry(path: string): WorktreeEntry {
      return { path, branch: null, head: 'abc', isDetached: false, isPrunable: false, isBare: false, isMain: false };
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
