import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename, join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Hono } from 'hono';
import type { DeployRouteDeps } from './shared.js';
import { isProtectedWorktreePath } from '../../adapters/worktree-marker.js';
import { getToolkitSymlinkStatus, type ToolkitSymlinkStatus } from '../toolkit-symlink-status.js';
import { getPluginVersionStatus, type PluginVersionStatus } from '../plugin-version-status.js';

const execFileAsync = promisify(execFile);

const PROD_PORT = 4800;

/** Fallback marketplace plugin id when the manifests can't be read. */
const DEFAULT_PLUGIN_ID = 'kookr-toolkit@kookr';

/** Filename written by scripts/prod-restart.sh after a successful restart (issue #1973). */
export const LAST_RESTART_METRICS_FILE = 'last-restart-metrics.json';

/**
 * Last successful `prod:restart` phase timings, exposed on GET /api/deploy/status.
 * Written by scripts/prod-restart.sh; omitted when the metrics file is missing
 * or unparseable (never a 500).
 */
export interface LastRestartMetrics {
  at: string;
  m1Seconds: number;
  m2Seconds: number;
  apiBlackoutSeconds: number;
  dominantPhase: string;
  /** Optional extras from the on-disk metrics file. */
  portFreeSeconds?: number;
  smokeSeconds?: number;
  totalSeconds?: number;
  path?: string;
}

/**
 * Resolve the state dir that holds last-restart-metrics.json.
 * Mirrors scripts/prod-restart.sh / src/server/start.ts:
 *   port 4800 → ~/.kookr, other ports → ~/.kookr-<port>.
 */
export function resolveDeployMetricsDir(
  deps: Pick<DeployRouteDeps, 'kookrDir' | 'serverPort' | 'hookHomeDir'>,
): string {
  if (deps.kookrDir) return deps.kookrDir;
  const home = deps.hookHomeDir ?? homedir();
  return deps.serverPort === PROD_PORT ? join(home, '.kookr') : join(home, `.kookr-${deps.serverPort}`);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Best-effort read of last-restart-metrics.json. Returns null on missing file,
 * parse errors, or incomplete shape — never throws.
 */
export async function readLastRestartMetrics(kookrDir: string): Promise<LastRestartMetrics | null> {
  try {
    const raw = await readFile(join(kookrDir, LAST_RESTART_METRICS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const m1 = asFiniteNumber(parsed.m1Seconds);
    const m2 = asFiniteNumber(parsed.m2Seconds);
    const blackout = asFiniteNumber(parsed.apiBlackoutSeconds);
    const at = typeof parsed.at === 'string' ? parsed.at : null;
    const dominant = typeof parsed.dominantPhase === 'string' ? parsed.dominantPhase : null;
    if (m1 === null || m2 === null || blackout === null || !at || !dominant) {
      return null;
    }
    const out: LastRestartMetrics = {
      at,
      m1Seconds: m1,
      m2Seconds: m2,
      apiBlackoutSeconds: blackout,
      dominantPhase: dominant,
    };
    const portFree = asFiniteNumber(parsed.portFreeSeconds);
    if (portFree !== null) out.portFreeSeconds = portFree;
    const smoke = asFiniteNumber(parsed.smokeSeconds);
    if (smoke !== null) out.smokeSeconds = smoke;
    const total = asFiniteNumber(parsed.totalSeconds);
    if (total !== null) out.totalSeconds = total;
    if (typeof parsed.path === 'string') out.path = parsed.path;
    return out;
  } catch {
    return null;
  }
}

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
 * by the startup migration, and for tests that wire a minimal DeployRouteDeps.
 */
export function resolveProdDir(deps: Pick<DeployRouteDeps, 'serverCwd' | 'worktreeRegistry'>): string {
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

function resolveInstallHooksScript(prodDir: string): string {
  return resolve(prodDir, 'scripts', 'install-hooks.sh');
}

async function readToolkitStatus(prodDir: string, hookHomeDir: string): Promise<
  { toolkit: ToolkitSymlinkStatus } | { toolkitError: string }
> {
  const installHooksScript = resolveInstallHooksScript(prodDir);
  try {
    await access(installHooksScript);
    return {
      toolkit: await getToolkitSymlinkStatus({ expectedRoot: prodDir, homeDir: hookHomeDir, installHooksScript }),
    };
  } catch (err) {
    return { toolkitError: err instanceof Error ? err.message : String(err) };
  }
}

interface AvailablePlugin {
  availableVersion: string | null;
  pluginId: string;
}

/** Parse `{name, version}` + marketplace name from two JSON manifest strings. */
function parseAvailablePlugin(pluginJsonRaw: string, marketplaceJsonRaw: string | null): AvailablePlugin {
  const pluginJson = JSON.parse(pluginJsonRaw) as { name?: unknown; version?: unknown };
  const availableVersion = typeof pluginJson.version === 'string' ? pluginJson.version : null;
  const pluginName = typeof pluginJson.name === 'string' ? pluginJson.name : null;
  let marketplaceName: string | null = null;
  if (marketplaceJsonRaw !== null) {
    try {
      const mkt = JSON.parse(marketplaceJsonRaw) as { name?: unknown };
      marketplaceName = typeof mkt.name === 'string' ? mkt.name : null;
    } catch {
      // marketplace.json malformed — fall back to the default id below.
    }
  }
  const pluginId = pluginName && marketplaceName ? `${pluginName}@${marketplaceName}` : DEFAULT_PLUGIN_ID;
  return { availableVersion, pluginId };
}

/** Read the plugin + marketplace manifests directly off disk under `treeDir`. */
async function readAvailableFromDisk(treeDir: string): Promise<AvailablePlugin | null> {
  try {
    const pluginJsonRaw = await readFile(join(treeDir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8');
    let marketplaceJsonRaw: string | null = null;
    try {
      marketplaceJsonRaw = await readFile(join(treeDir, '.claude-plugin', 'marketplace.json'), 'utf8');
    } catch {
      // optional
    }
    return parseAvailablePlugin(pluginJsonRaw, marketplaceJsonRaw);
  } catch {
    return null;
  }
}

/**
 * Resolve the latest *available* toolkit-plugin version + id. Prefers
 * `origin/main` of the prod tree (the same remote `/plugin marketplace update`
 * pulls from), then falls back to reading manifests on disk from the prod tree
 * and finally the running server's own checkout — so the value is present even
 * for a first-time user who has no `kookr-prod` deploy tree set up.
 */
async function resolveAvailablePlugin(prodDir: string | null, serverCwd: string): Promise<AvailablePlugin> {
  if (prodDir) {
    try {
      const pluginJsonRaw = await git(prodDir, 'show', 'origin/main:plugin/.claude-plugin/plugin.json');
      let marketplaceJsonRaw: string | null = null;
      try {
        marketplaceJsonRaw = await git(prodDir, 'show', 'origin/main:.claude-plugin/marketplace.json');
      } catch {
        // optional
      }
      const fromGit = parseAvailablePlugin(pluginJsonRaw, marketplaceJsonRaw);
      if (fromGit.availableVersion) return fromGit;
    } catch {
      // no origin/main yet — fall through to disk reads
    }
  }
  for (const tree of [prodDir, serverCwd].filter((t): t is string => Boolean(t))) {
    const fromDisk = await readAvailableFromDisk(tree);
    if (fromDisk?.availableVersion) return fromDisk;
  }
  return { availableVersion: null, pluginId: DEFAULT_PLUGIN_ID };
}

/**
 * Best-effort marketplace-plugin status: the installed version (from the user's
 * `~/.claude/plugins/`) compared against the latest available version. Surfaces
 * three cases to the dashboard — up to date, behind (stale), and not installed
 * at all (installedVersion null + availableVersion known) — so a first-time or
 * not-yet-installed user is nudged to install, not just to update. Never throws.
 */
async function readPluginVersionStatus(
  prodDir: string | null,
  serverCwd: string,
  homeDir: string,
): Promise<PluginVersionStatus | undefined> {
  try {
    const { availableVersion, pluginId } = await resolveAvailablePlugin(prodDir, serverCwd);
    return await getPluginVersionStatus({ homeDir, pluginId, availableVersion });
  } catch {
    return undefined;
  }
}

/**
 * Resolve the toolkit plugin's id + latest available version (git-sourced from
 * origin/main, falling back to on-disk manifests). Exported for the fleet read
 * model (`GET /api/plugins`) so the toolkit's git-based staleness is computed
 * from the same source the deploy status uses — no second available-version
 * path. Never throws; returns a null available version when it can't be read.
 */
export async function resolveToolkitAvailable(
  deps: DeployRouteDeps,
): Promise<{ pluginId: string; availableVersion: string | null }> {
  let prodDir: string | null = null;
  try {
    const candidate = resolveProdDir(deps);
    await access(candidate);
    prodDir = candidate;
  } catch {
    // No prod worktree — fall back to the running server checkout.
  }
  try {
    return await resolveAvailablePlugin(prodDir, deps.serverCwd);
  } catch {
    return { pluginId: DEFAULT_PLUGIN_ID, availableVersion: null };
  }
}

function commandFailureMessage(err: unknown): string {
  if (err instanceof Error) {
    const details: string[] = [err.message];
    if ('stderr' in err && typeof err.stderr === 'string' && err.stderr.trim()) {
      details.push(err.stderr.trim());
    }
    if ('stdout' in err && typeof err.stdout === 'string' && err.stdout.trim()) {
      details.push(err.stdout.trim());
    }
    return details.join('\n');
  }
  return String(err);
}

export function registerDeployRoutes(app: Hono, deps: DeployRouteDeps): void {
  const prodUpdateScript = resolveProdUpdateScript(deps.serverCwd);
  const runningPort = deps.serverPort;
  const hookHomeDir = deps.hookHomeDir ?? homedir();
  let deploying = false;
  let toolkitRefreshing = false;

  app.get('/api/deploy/status', async (c) => {
    // lastRestart is best-effort (issue #1973): never 500 if the metrics file
    // is missing or corrupt — omit the field instead.
    const lastRestart = await readLastRestartMetrics(resolveDeployMetricsDir(deps));
    const lastRestartField = lastRestart ? { lastRestart } : {};

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
          ...lastRestartField,
        },
        500,
      );
    }

    // Computed before the prod-existence gate so the install nudge reaches a
    // first-time user who has no kookr-prod tree (falls back to the running
    // server's own checkout for the available version).
    const pluginStatus = await readPluginVersionStatus(prodDir, deps.serverCwd, hookHomeDir);
    const pluginField = pluginStatus ? { plugin: pluginStatus } : {};

    try {
      await access(prodDir);
    } catch {
      return c.json({
        configured: false,
        ...pluginField,
        runningPort,
        prodPort: PROD_PORT,
        ...lastRestartField,
      });
    }

    const toolkitStatus = await readToolkitStatus(prodDir, hookHomeDir);

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
        ...toolkitStatus,
        ...pluginField,
        currentCommit,
        currentShort,
        latestCommit,
        latestShort,
        behindCount,
        commits,
        runningPort,
        prodPort: PROD_PORT,
        ...lastRestartField,
      });
    } catch (err) {
      return c.json(
        {
          configured: true,
          error: err instanceof Error ? err.message : String(err),
          ...toolkitStatus,
          ...pluginField,
          runningPort,
          prodPort: PROD_PORT,
          ...lastRestartField,
        },
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

    // Issue #1980: mark in-flight and notify connected clients *before* the
    // child starts so dashboards still receive deployLifecycle over a live WS.
    // Script-path prod:restart (no trigger) does not emit this event.
    deploying = true;
    deps.broadcastToAll?.({ type: 'deployLifecycle', phase: 'starting' });

    let child;
    try {
      child = spawn('bash', [prodUpdateScript], {
        detached: true,
        stdio: 'ignore',
        cwd: prodDir,
        env: { ...process.env, KOOKR_PROD_DIR: prodDir, KOOKR_PORT: String(PROD_PORT) },
      });
    } catch (err) {
      deploying = false;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

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

  app.post('/api/deploy/toolkit-refresh', async (c) => {
    if (toolkitRefreshing) {
      return c.json({ error: 'Toolkit refresh already in progress' }, 409);
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

    const installHooksScript = resolveInstallHooksScript(prodDir);
    try {
      await access(installHooksScript);
    } catch {
      return c.json({ error: `install-hooks script not found at ${installHooksScript}` }, 400);
    }

    toolkitRefreshing = true;
    try {
      await execFileAsync('bash', [installHooksScript], {
        cwd: prodDir,
        timeout: 60_000,
        env: { ...gitEnv, HOME: hookHomeDir },
      });
      return c.json({
        status: 'refreshed',
        toolkit: await getToolkitSymlinkStatus({ expectedRoot: prodDir, homeDir: hookHomeDir, installHooksScript }),
      });
    } catch (err) {
      console.error(`[deploy] toolkit refresh failed prodDir=${prodDir} home=${hookHomeDir}: ${commandFailureMessage(err)}`);
      return c.json({
        error: commandFailureMessage(err),
        ...(await readToolkitStatus(prodDir, hookHomeDir)),
      }, 500);
    } finally {
      toolkitRefreshing = false;
    }
  });
}
