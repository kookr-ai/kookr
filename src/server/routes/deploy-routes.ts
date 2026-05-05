import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename } from 'node:path';
import { access } from 'node:fs/promises';
import type { Hono } from 'hono';
import type { RouteDeps } from './shared.js';

const execFileAsync = promisify(execFile);

const PROD_PORT = 4800;

/** Strip GIT_DIR/GIT_WORK_TREE so commands run against the target cwd, not the parent repo. */
const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000, env: gitEnv });
  return stdout.trim();
}

function resolveProdDir(serverCwd: string): string {
  // If we ARE the prod worktree, use ourselves; otherwise sibling ../kookr-prod
  if (basename(serverCwd) === 'kookr-prod') return serverCwd;
  return resolve(serverCwd, '../kookr-prod');
}

function resolveProdUpdateScript(serverCwd: string): string {
  return resolve(serverCwd, 'scripts', 'prod-update.sh');
}

export function registerDeployRoutes(app: Hono, deps: RouteDeps): void {
  const prodDir = resolveProdDir(deps.serverCwd);
  const prodUpdateScript = resolveProdUpdateScript(deps.serverCwd);
  let deploying = false;

  app.get('/api/deploy/status', async (c) => {
    try {
      await access(prodDir);
    } catch {
      return c.json({ configured: false });
    }

    try {
      await git(prodDir, 'fetch', 'origin');

      const [currentCommit, currentShort, latestCommit, latestShort, behindStr] =
        await Promise.all([
          git(prodDir, 'rev-parse', 'HEAD'),
          git(prodDir, 'rev-parse', '--short', 'HEAD'),
          git(prodDir, 'rev-parse', 'origin/main'),
          git(prodDir, 'rev-parse', '--short', 'origin/main'),
          git(prodDir, 'rev-list', '--count', 'HEAD..origin/main'),
        ]);

      const behindCount = parseInt(behindStr, 10);

      let commits: { hash: string; subject: string }[] = [];
      if (behindCount > 0) {
        const log = await git(prodDir, 'log', '--format=%h|%s', 'HEAD..origin/main');
        commits = log
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const sep = line.indexOf('|');
            return { hash: line.slice(0, sep), subject: line.slice(sep + 1) };
          });
      }

      return c.json({
        configured: true,
        available: behindCount > 0,
        deploying,
        currentCommit,
        currentShort,
        latestCommit,
        latestShort,
        behindCount,
        commits,
      });
    } catch (err) {
      return c.json(
        { configured: true, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.post('/api/deploy/trigger', async (c) => {
    if (deploying) {
      return c.json({ error: 'Deployment already in progress' }, 409);
    }

    try {
      await access(prodDir);
    } catch {
      return c.json({ error: 'Production directory not found' }, 400);
    }

    let child;
    try {
      child = spawn('bash', [prodUpdateScript], {
        detached: true,
        stdio: 'ignore',
        cwd: prodDir,
        env: { ...process.env, KOOKR_PROD_DIR: prodDir, KOOKR_PORT: String(PROD_PORT) },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    deploying = true;
    child.unref();

    // Reset deploying flag when the child exits or after a timeout safety net
    child.on('exit', () => {
      deploying = false;
    });
    const safetyTimer = setTimeout(() => {
      deploying = false;
    }, 5 * 60 * 1000);
    safetyTimer.unref();

    return c.json({ status: 'deploying', prodDir });
  });
}
