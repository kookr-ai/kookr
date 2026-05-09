import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename } from 'node:path';
import { access } from 'node:fs/promises';
import type { Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import { isProtectedWorktreePath } from '../../adapters/worktree-marker.js';

const execFileAsync = promisify(execFile);

const PROD_PORT = 4800;

/** Strip GIT_DIR/GIT_WORK_TREE so commands run against the target cwd, not the parent repo. */
const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000, env: gitEnv });
  return stdout.trim();
}

/**
 * Locate the production worktree.
 *
 * Marker-first: scan the worktree registry for paths carrying the
 * `.kookr-protected` marker. Single match → that path; multiple matches →
 * throw (operator misconfiguration). When the registry is unavailable or
 * holds no markers, fall back to the legacy `kookr-prod` basename heuristic
 * — necessary for fresh installs where the marker has not yet been written
 * by the startup migration, and for tests that wire a minimal RouteDeps.
 */
export function resolveProdDir(deps: Pick<RouteDeps, 'serverCwd' | 'worktreeRegistry'>): string {
  const registry = deps.worktreeRegistry;
  if (registry) {
    const protectedPaths = registry.all()
      .map((entry) => entry.path)
      .filter((p) => isProtectedWorktreePath(p));
    if (protectedPaths.length > 1) {
      throw new Error(
        `[deploy] multiple .kookr-protected worktrees found: ${protectedPaths.join(', ')}. ` +
          'Only one production worktree may carry the marker; remove duplicates.',
      );
    }
    if (protectedPaths.length === 1) return protectedPaths[0];
  }
  if (basename(deps.serverCwd) === 'kookr-prod') return deps.serverCwd;
  return resolve(deps.serverCwd, '../kookr-prod');
}

function resolveProdUpdateScript(serverCwd: string): string {
  return resolve(serverCwd, 'scripts', 'prod-update.sh');
}

export function registerDeployRoutes(app: Hono, deps: RouteDeps): void {
  const prodUpdateScript = resolveProdUpdateScript(deps.serverCwd);
  const runningPort = deps.serverPort;
  let deploying = false;

  app.get('/api/deploy/status', async (c) => {
    let prodDir: string;
    try {
      prodDir = resolveProdDir(deps);
    } catch (err) {
      return c.json(
        {
          configured: true,
          error: err instanceof Error ? err.message : String(err),
          runningPort,
          prodPort: PROD_PORT,
        },
        500,
      );
    }

    try {
      await access(prodDir);
    } catch {
      return c.json({ configured: false, runningPort, prodPort: PROD_PORT });
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
        runningPort,
        prodPort: PROD_PORT,
      });
    } catch (err) {
      return c.json(
        {
          configured: true,
          error: err instanceof Error ? err.message : String(err),
          runningPort,
          prodPort: PROD_PORT,
        },
        500,
      );
    }
  });

  app.post('/api/deploy/trigger', async (c) => {
    if (deploying) {
      return c.json({ error: 'Deployment already in progress' }, 409);
    }

    let prodDir: string;
    try {
      prodDir = resolveProdDir(deps);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
