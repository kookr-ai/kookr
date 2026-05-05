import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerDeployRoutes } from './deploy-routes.js';
import type { RouteDeps } from './shared.js';

/** Strip GIT_DIR so git subprocesses work in test dirs, not the repo. */
const cleanEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

function makeApp(serverCwd: string): Hono {
  const app = new Hono();
  registerDeployRoutes(app, { serverCwd } as unknown as RouteDeps);
  return app;
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
});
