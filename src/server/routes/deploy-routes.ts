import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename, join } from 'node:path';
import { access, readFile, cp, rm, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Hono } from 'hono';
import type { DeployRouteDeps } from './shared.js';
import { isProtectedWorktreePath } from '../../adapters/worktree-marker.js';
import { getToolkitSymlinkStatus, type ToolkitSymlinkStatus } from '../toolkit-symlink-status.js';
import { getPluginVersionStatus, type PluginVersionStatus } from '../plugin-version-status.js';
import {
  marketplaceNameFromPluginId,
  pluginUpdateCommands,
  pluginInstallCommands,
  TOOLKIT_MARKETPLACE_SLUG,
  type PluginUpdateError,
  type PluginUpdateResult,
  type PluginInstallResult,
} from '../../shared/contracts/plugin-version.js';

const execFileAsync = promisify(execFile);

const PROD_PORT = 4800;

/** Fallback marketplace plugin id when the manifests can't be read. */
const DEFAULT_PLUGIN_ID = 'kookr-toolkit@kookr';

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

async function readPluginStatusForUpdate(
  deps: DeployRouteDeps,
  hookHomeDir: string,
): Promise<PluginVersionStatus | undefined> {
  let prodDir: string | null = null;
  try {
    const candidate = resolveProdDir(deps);
    await access(candidate);
    prodDir = candidate;
  } catch {
    // Plugin updates do not require a production worktree; fall back to the
    // running server checkout for available-version discovery.
  }
  return await readPluginVersionStatus(prodDir, deps.serverCwd, hookHomeDir);
}

export function registerDeployRoutes(app: Hono, deps: DeployRouteDeps): void {
  const prodUpdateScript = resolveProdUpdateScript(deps.serverCwd);
  const runningPort = deps.serverPort;
  const hookHomeDir = deps.hookHomeDir ?? homedir();
  let deploying = false;
  let toolkitRefreshing = false;
  /** Single shared lock for all operations that mutate ~/.claude/plugins/. */
  let pluginMutating = false;
  const pluginUpdateBin = deps.pluginUpdateBin ?? process.env.KOOKR_AGENT_BIN ?? 'claude';

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

    // Computed before the prod-existence gate so the install nudge reaches a
    // first-time user who has no kookr-prod tree (falls back to the running
    // server's own checkout for the available version).
    const pluginStatus = await readPluginVersionStatus(prodDir, deps.serverCwd, hookHomeDir);
    const pluginField = pluginStatus ? { plugin: pluginStatus } : {};

    try {
      await access(prodDir);
    } catch {
      return c.json({ configured: false, ...pluginField, runningPort, prodPort: PROD_PORT });
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

  app.post('/api/deploy/plugin-update', async (c) => {
    if (pluginMutating) {
      const pluginStatus = await readPluginStatusForUpdate(deps, hookHomeDir);
      const pluginId = pluginStatus?.pluginId ?? DEFAULT_PLUGIN_ID;
      const marketplace = marketplaceNameFromPluginId(pluginId);
      return c.json<PluginUpdateError>({
        error: 'Plugin update already in progress',
        commands: pluginUpdateCommands(pluginId, marketplace),
        ...(pluginStatus ? { plugin: pluginStatus } : {}),
      }, 409);
    }

    pluginMutating = true;
    try {
      const pluginStatus = await readPluginStatusForUpdate(deps, hookHomeDir);
      if (!pluginStatus) {
        const marketplace = marketplaceNameFromPluginId(DEFAULT_PLUGIN_ID);
        return c.json<PluginUpdateError>({
          error: 'Could not determine toolkit plugin status',
          commands: pluginUpdateCommands(DEFAULT_PLUGIN_ID, marketplace),
        }, 500);
      }

      const marketplace = marketplaceNameFromPluginId(pluginStatus.pluginId);
      const commands = pluginUpdateCommands(pluginStatus.pluginId, marketplace);
      if (pluginStatus.installedVersion === null) {
        return c.json<PluginUpdateError>({
          error: 'Toolkit plugin is not installed yet',
          commands,
          plugin: pluginStatus,
        }, 400);
      }

      await execFileAsync(pluginUpdateBin, ['plugin', 'marketplace', 'update', marketplace], {
        cwd: deps.serverCwd,
        timeout: 120_000,
        env: { ...gitEnv, HOME: hookHomeDir },
      });
      await execFileAsync(pluginUpdateBin, ['plugin', 'update', pluginStatus.pluginId], {
        cwd: deps.serverCwd,
        timeout: 120_000,
        env: { ...gitEnv, HOME: hookHomeDir },
      });
      const plugin = await readPluginStatusForUpdate(deps, hookHomeDir) ?? pluginStatus;
      return c.json<PluginUpdateResult>({ status: 'updated', plugin, commands });
    } catch (err) {
      console.error(
        `[deploy] plugin update failed bin=${pluginUpdateBin} home=${hookHomeDir}: ${commandFailureMessage(err)}`,
      );
      const plugin = await readPluginStatusForUpdate(deps, hookHomeDir);
      const pluginId = plugin?.pluginId ?? DEFAULT_PLUGIN_ID;
      const marketplace = marketplaceNameFromPluginId(pluginId);
      return c.json<PluginUpdateError>({
        error: commandFailureMessage(err),
        commands: pluginUpdateCommands(pluginId, marketplace),
        ...(plugin ? { plugin } : {}),
      }, 500);
    } finally {
      pluginMutating = false;
    }
  });

  app.post('/api/deploy/plugin-install', async (c) => {
    if (pluginMutating) {
      const pluginStatus = await readPluginStatusForUpdate(deps, hookHomeDir);
      const pluginId = pluginStatus?.pluginId ?? DEFAULT_PLUGIN_ID;
      return c.json<PluginUpdateError>({
        error: 'Plugin install already in progress',
        commands: pluginInstallCommands(pluginId, TOOLKIT_MARKETPLACE_SLUG),
        ...(pluginStatus ? { plugin: pluginStatus } : {}),
      }, 409);
    }

    pluginMutating = true;
    try {
      const pluginStatus = await readPluginStatusForUpdate(deps, hookHomeDir);
      if (!pluginStatus) {
        return c.json<PluginUpdateError>({
          error: 'Could not determine toolkit plugin status',
          commands: pluginInstallCommands(DEFAULT_PLUGIN_ID, TOOLKIT_MARKETPLACE_SLUG),
        }, 500);
      }

      const commands = pluginInstallCommands(pluginStatus.pluginId, TOOLKIT_MARKETPLACE_SLUG);

      if (pluginStatus.installedVersion !== null) {
        return c.json<PluginUpdateError>({
          error: 'Toolkit plugin is already installed',
          commands,
          plugin: pluginStatus,
        }, 400);
      }

      // --- Back up the plugins directory before any mutation ---
      const pluginsDir = join(resolve(hookHomeDir), '.claude', 'plugins');
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 7);
      const backupDir = `${pluginsDir}.kookr-install-backup-${ts}-${process.pid}-${rand}`;
      let pluginsDirExistedBefore = false;
      try {
        await access(pluginsDir);
        pluginsDirExistedBefore = true;
        await cp(pluginsDir, backupDir, { recursive: true });
      } catch {
        // plugins dir doesn't exist yet — no backup needed; record that fact
        pluginsDirExistedBefore = false;
      }

      /**
       * Atomically restore the plugins dir on failure.
       *
       * Returns `{ ok: true }` on success, or `{ ok: false, backupPath }` when
       * the original config could not be fully restored (caller should surface
       * `backupPath` in the HTTP 500 body so the user can recover manually).
       */
      const restoreOnFailure = async (): Promise<{ ok: boolean; backupPath?: string }> => {
        if (!pluginsDirExistedBefore) {
          // Dir did not exist before the install — just remove what was created.
          await rm(pluginsDir, { recursive: true, force: true });
          return { ok: true };
        }

        // Dir existed before: move the partial aside first, THEN restore the backup.
        const partialTs = Date.now();
        const partialDir = `${pluginsDir}.kookr-failed-${partialTs}`;
        try {
          // Step 1: move the failed/partial install out of the way (if it exists)
          try {
            await rename(pluginsDir, partialDir);
          } catch {
            // pluginsDir may not exist at all (install errored before creating it) — that's fine
          }

          // Step 2: restore the backup into the canonical location
          await rename(backupDir, pluginsDir);

          // Step 3: remove the partial (best-effort, backup is already restored)
          await rm(partialDir, { recursive: true, force: true });

          return { ok: true };
        } catch (restoreErr) {
          console.error(`[deploy] plugin install backup restore failed: ${String(restoreErr)}`);
          // The original config is still in backupDir — tell the caller.
          return { ok: false, backupPath: backupDir };
        }
      };

      // --- Run the two install commands ---
      try {
        await execFileAsync(pluginUpdateBin, ['plugin', 'marketplace', 'add', TOOLKIT_MARKETPLACE_SLUG], {
          cwd: deps.serverCwd,
          timeout: 120_000,
          env: { ...gitEnv, HOME: hookHomeDir },
        });
        await execFileAsync(pluginUpdateBin, ['plugin', 'install', pluginStatus.pluginId], {
          cwd: deps.serverCwd,
          timeout: 120_000,
          env: { ...gitEnv, HOME: hookHomeDir },
        });

        // --- Verify the install succeeded (retry up to 3 times, ~150ms apart) ---
        let verifiedStatus = await readPluginStatusForUpdate(deps, hookHomeDir);
        if (!verifiedStatus || verifiedStatus.installedVersion === null) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            await new Promise<void>((res) => setTimeout(res, 150));
            verifiedStatus = await readPluginStatusForUpdate(deps, hookHomeDir);
            if (verifiedStatus?.installedVersion !== null) break;
          }
        }

        if (!verifiedStatus || verifiedStatus.installedVersion === null) {
          const restoreResult = await restoreOnFailure();
          const recoveryNote = restoreResult.ok
            ? ''
            : ` Your previous Claude plugin config is preserved at ${restoreResult.backupPath}`;
          console.error(
            `[deploy] plugin install verification failed bin=${pluginUpdateBin} home=${hookHomeDir}: installedVersion is still null after install`,
          );
          return c.json<PluginUpdateError>({
            error: `Plugin install command succeeded but the plugin does not appear to be installed. Check Claude Code manually.${recoveryNote}`,
            commands,
            plugin: verifiedStatus ?? pluginStatus,
          }, 500);
        }

        // --- Success: delete backup ---
        if (pluginsDirExistedBefore) {
          try {
            await rm(backupDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup
          }
        }

        const plugin = verifiedStatus;
        return c.json<PluginInstallResult>({ status: 'installed', plugin, commands });
      } catch (err) {
        const restoreResult = await restoreOnFailure();
        const recoveryNote = restoreResult.ok
          ? ''
          : ` Your previous Claude plugin config is preserved at ${restoreResult.backupPath}`;
        console.error(
          `[deploy] plugin install failed bin=${pluginUpdateBin} home=${hookHomeDir}: ${commandFailureMessage(err)}`,
        );
        const refreshedStatus = await readPluginStatusForUpdate(deps, hookHomeDir);
        return c.json<PluginUpdateError>({
          error: `${commandFailureMessage(err)}${recoveryNote}`,
          commands,
          ...(refreshedStatus ? { plugin: refreshedStatus } : { plugin: pluginStatus }),
        }, 500);
      }
    } finally {
      pluginMutating = false;
    }
  });
}
