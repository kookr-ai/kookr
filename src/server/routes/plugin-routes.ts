import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Hono } from 'hono';
import type { DeployRouteDeps } from './shared.js';
import { resolveToolkitAvailable } from './deploy-routes.js';
import { PluginMutationService, PluginMutationBusyError } from '../plugin-manager/mutation-service.js';
import { ClaudePluginCli, execFilePluginCliRunner } from '../plugin-manager/cli.js';
import { assembleManagedPlugins } from '../plugin-manager/read-model.js';
import { readInstalledVersionFromRegistry } from '../plugin-manager/registry.js';
import { getPluginVersionStatus } from '../plugin-version-status.js';
import { LoadoutStore } from '../plugin-manager/loadout-store.js';
import { ConfigEpochStore } from '../plugin-manager/config-epoch.js';
import { OwnSessionAssist, OwnSessionMutationError } from '../plugin-manager/own-session.js';
import {
  ClaudeSettingsStore,
  ConcurrentSettingsWriteError,
  defaultScopeFiles,
  type SettingsScope,
} from '../../core/claude-settings/settings-store.js';
import {
  TOOLKIT_MARKETPLACE_SLUG,
  pluginInstallCommands,
  type PluginInstallResult,
  type PluginUpdateError,
  type PluginVersionStatus,
} from '../../shared/contracts/plugin-version.js';
import type {
  ManagedPlugin,
  PluginsReadModel,
  PluginUpdateOutcome,
  PluginActionError,
  LoadoutLevel,
  LoadoutDesiredState,
  LoadoutSpawnMode,
  OwnSessionScope,
  OwnSessionEnablementRequest,
  OwnSessionEnablementResult,
  OwnSessionMarketplaceRequest,
  OwnSessionInstallRequest,
  OwnSessionActionResult,
  OwnSessionActionError,
  PluginEnablement,
} from '../../shared/contracts/plugins.js';
import {
  LOADOUT_LEVELS_MOST_SPECIFIC_FIRST,
  OWN_SESSION_BLAST_RADIUS,
} from '../../shared/contracts/plugins.js';

/** Strip GIT_DIR/GIT_WORK_TREE so `claude` subprocesses run against the user's home, not the parent repo. */
const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

function pluginCliFor(deps: DeployRouteDeps, hookHomeDir: string): ClaudePluginCli {
  const bin = deps.pluginUpdateBin ?? process.env.KOOKR_AGENT_BIN ?? 'claude';
  return new ClaudePluginCli(execFilePluginCliRunner(bin, { ...gitEnv, HOME: hookHomeDir }));
}

function settingsStoreFor(deps: DeployRouteDeps, hookHomeDir: string): ClaudeSettingsStore {
  return new ClaudeSettingsStore(defaultScopeFiles(deps.serverCwd, hookHomeDir));
}

/** The config-epoch store (RFC "Surfacing reload drift"), bumped on every own-session mutation. */
function epochStoreFor(deps: DeployRouteDeps): ConfigEpochStore {
  return new ConfigEpochStore(deps.kookrDir ?? deps.serverCwd);
}

/** Own-session assist (RFC G3/R4): install/add-marketplace/enable-disable for the operator's OWN sessions. */
function ownSessionAssistFor(
  deps: DeployRouteDeps,
  hookHomeDir: string,
  mutation: PluginMutationService,
): OwnSessionAssist {
  return new OwnSessionAssist({
    cli: pluginCliFor(deps, hookHomeDir),
    settings: settingsStoreFor(deps, hookHomeDir),
    mutation,
    epoch: epochStoreFor(deps),
    pluginsDir: join(resolve(hookHomeDir), '.claude', 'plugins'),
    // The CLI can exit 0 without the install landing; verify against the
    // registry (short retry — the registry lags the CLI), mirroring the toolkit
    // install route's verification.
    verifyInstalled: async (pluginId) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if ((await readInstalledVersionFromRegistry(hookHomeDir, pluginId)) !== null) return true;
        await new Promise<void>((res) => setTimeout(res, 150));
      }
      return (await readInstalledVersionFromRegistry(hookHomeDir, pluginId)) !== null;
    },
  });
}

const OWN_SESSION_SCOPES: readonly OwnSessionScope[] = ['user', 'userLocal', 'project', 'projectLocal'];

/** Validate an untrusted scope, defaulting to `user` when omitted. Returns null when invalid. */
function normalizeOwnSessionScope(value: unknown): SettingsScope | null {
  if (value === undefined || value === null) return 'user';
  return (OWN_SESSION_SCOPES as readonly string[]).includes(value as string)
    ? (value as SettingsScope)
    : null;
}

/** Map an own-session mutation failure to the right HTTP status + body. */
function ownSessionErrorResponse(
  c: import('hono').Context,
  err: unknown,
): Response {
  if (err instanceof PluginMutationBusyError) {
    return c.json<OwnSessionActionError>(
      { error: 'Plugin mutation already in progress', lockHolder: err.holder },
      409,
    );
  }
  if (err instanceof ConcurrentSettingsWriteError) {
    return c.json<OwnSessionActionError>(
      { error: `${err.message}. Retry after reviewing the file.` },
      409,
    );
  }
  if (err instanceof OwnSessionMutationError) {
    const note = err.restoredOk
      ? ''
      : ` Your previous Claude config is preserved at ${err.backupPath}`;
    return c.json<OwnSessionActionError>({ error: `${err.message}${note}` }, 500);
  }
  return c.json<OwnSessionActionError>({ error: errorMessage(err) }, 500);
}

/**
 * The loadout store for authoring/dry-run routes (RFC Layer 2 / slice 2a).
 * Points at the SAME `<kookrDir>/plugin-loadouts.json` the launcher reads, so an
 * authored loadout is visible to the next spawn. Falls back to `serverCwd` when
 * `kookrDir` is absent (matching the other route-side stores).
 */
function loadoutStoreFor(deps: DeployRouteDeps): LoadoutStore {
  return new LoadoutStore(deps.kookrDir ?? deps.serverCwd);
}

function isLoadoutLevel(value: string): value is LoadoutLevel {
  return (LOADOUT_LEVELS_MOST_SPECIFIC_FIRST as readonly string[]).includes(value);
}

/** Coerce an untrusted request body into a plugin-level desired state (plugin id → boolean). */
function parseDesiredState(body: unknown): LoadoutDesiredState | null {
  if (typeof body !== 'object' || body === null) return null;
  const plugins = (body as { plugins?: unknown }).plugins;
  if (typeof plugins !== 'object' || plugins === null) return null;
  const clean: Record<string, boolean> = {};
  for (const [id, v] of Object.entries(plugins as Record<string, unknown>)) {
    if (typeof v !== 'boolean') return null; // reject malformed rather than silently drop
    if (!id.includes('@')) return null; // ids are `<name>@<marketplace>`
    clean[id] = v;
  }
  return { plugins: clean };
}

/**
 * Assemble the fleet read model once. `fetchTokens` triggers a `claude plugin
 * details` per plugin for the always-on cost — on by default for the fleet view.
 */
async function buildReadModel(
  deps: DeployRouteDeps,
  hookHomeDir: string,
  fetchTokens: boolean,
): Promise<ManagedPlugin[]> {
  const cli = pluginCliFor(deps, hookHomeDir);
  const settings = settingsStoreFor(deps, hookHomeDir);
  const toolkitAvailable = await resolveToolkitAvailable(deps);
  return assembleManagedPlugins({ cli, settings, homeDir: hookHomeDir, toolkitAvailable, fetchTokens });
}

/**
 * Toolkit install/stale projection for the install banner + TopBar badge
 * (replaces the deploy-status `plugin` field as the frontend's source). Present
 * even when not installed (installedVersion null + availableVersion known).
 */
async function buildToolkitProjection(
  deps: DeployRouteDeps,
  hookHomeDir: string,
): Promise<PluginVersionStatus | null> {
  try {
    const { pluginId, availableVersion } = await resolveToolkitAvailable(deps);
    return await getPluginVersionStatus({ homeDir: hookHomeDir, pluginId, availableVersion });
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const details: string[] = [err.message];
    if ('stderr' in err && typeof err.stderr === 'string' && err.stderr.trim()) details.push(err.stderr.trim());
    return details.join('\n');
  }
  return String(err);
}

/**
 * Fleet Plugin Manager routes (RFC Layer 1). `GET /api/plugins` is the read
 * model over every installed plugin; `POST /api/plugins/:id/update` updates one
 * plugin through the shared mutation lock + backup (R8). No update-all (a
 * half-updated fleet is a footgun — deferred).
 */
export function registerPluginRoutes(app: Hono, deps: DeployRouteDeps): void {
  const hookHomeDir = deps.hookHomeDir ?? homedir();
  const pluginMutation = deps.pluginMutationService ?? new PluginMutationService();

  app.get('/api/plugins', async (c) => {
    try {
      const [plugins, toolkit] = await Promise.all([
        buildReadModel(deps, hookHomeDir, true),
        buildToolkitProjection(deps, hookHomeDir),
      ]);
      return c.json<PluginsReadModel>({ plugins, toolkit });
    } catch (err) {
      // Degrade, don't 500: an empty fleet is a legible "nothing installed" state.
      console.error(`[plugins] read model failed home=${hookHomeDir}: ${errorMessage(err)}`);
      return c.json<PluginsReadModel>({ plugins: [], toolkit: null });
    }
  });

  // Toolkit install (RFC Layer 1 / G3) — moved from POST /api/deploy/plugin-install
  // (slice 1d). Backs up ~/.claude/plugins before mutating and restores on
  // failure, through the shared lock (R8). Returns the install/stale projection.
  app.post('/api/plugins/install', async (c) => {
    const pluginsDir = join(resolve(hookHomeDir), '.claude', 'plugins');
    const cli = pluginCliFor(deps, hookHomeDir);
    const { pluginId } = await resolveToolkitAvailable(deps);
    const commands = pluginInstallCommands(pluginId, TOOLKIT_MARKETPLACE_SLUG);

    const installedNow = await readInstalledVersionFromRegistry(hookHomeDir, pluginId);
    if (installedNow !== null) {
      const plugin = await buildToolkitProjection(deps, hookHomeDir);
      return c.json<PluginUpdateError>(
        { error: 'Toolkit plugin is already installed', commands, ...(plugin ? { plugin } : {}) },
        400,
      );
    }

    if (pluginMutation.isLocked) {
      const plugin = await buildToolkitProjection(deps, hookHomeDir);
      return c.json<PluginUpdateError>(
        { error: 'Plugin install already in progress', commands, ...(plugin ? { plugin } : {}) },
        409,
      );
    }

    try {
      return await pluginMutation.withLock('plugin-install', async () => {
        const backup = await pluginMutation.backupPluginsDir(pluginsDir);
        try {
          await cli.marketplaceAdd(TOOLKIT_MARKETPLACE_SLUG);
          await cli.install(pluginId);
          // Verify (retry up to 3×, ~150ms apart) — the registry lags the CLI.
          let installed = await readInstalledVersionFromRegistry(hookHomeDir, pluginId);
          for (let attempt = 0; attempt < 3 && installed === null; attempt++) {
            await new Promise<void>((res) => setTimeout(res, 150));
            installed = await readInstalledVersionFromRegistry(hookHomeDir, pluginId);
          }
          if (installed === null) {
            const restore = await backup.restore();
            const note = restore.ok
              ? ''
              : ` Your previous Claude plugin config is preserved at ${restore.backupPath}`;
            const plugin = await buildToolkitProjection(deps, hookHomeDir);
            return c.json<PluginUpdateError>(
              {
                error: `Plugin install command succeeded but the plugin does not appear to be installed. Check Claude Code manually.${note}`,
                commands,
                ...(plugin ? { plugin } : {}),
              },
              500,
            );
          }
          await backup.discard();
          const plugin = await buildToolkitProjection(deps, hookHomeDir);
          return c.json<PluginInstallResult>({
            status: 'installed',
            plugin: plugin ?? { pluginId, installedVersion: installed, availableVersion: null, stale: false },
            commands,
          });
        } catch (err) {
          const restore = await backup.restore();
          const note = restore.ok
            ? ''
            : ` Your previous Claude plugin config is preserved at ${restore.backupPath}`;
          console.error(`[plugins] install failed home=${hookHomeDir}: ${errorMessage(err)}`);
          const plugin = await buildToolkitProjection(deps, hookHomeDir);
          return c.json<PluginUpdateError>(
            { error: `${errorMessage(err)}${note}`, commands, ...(plugin ? { plugin } : {}) },
            500,
          );
        }
      });
    } catch (err) {
      if (err instanceof PluginMutationBusyError) {
        const plugin = await buildToolkitProjection(deps, hookHomeDir);
        return c.json<PluginUpdateError>(
          { error: 'Plugin install already in progress', commands, ...(plugin ? { plugin } : {}) },
          409,
        );
      }
      return c.json<PluginUpdateError>({ error: errorMessage(err), commands }, 500);
    }
  });

  app.post('/api/plugins/:id/update', async (c) => {
    const id = c.req.param('id');
    if (!id || !id.includes('@')) {
      return c.json<PluginActionError>({ error: 'Invalid plugin id', pluginId: id }, 400);
    }

    if (pluginMutation.isLocked) {
      const holder = pluginMutation.currentHolder;
      return c.json<PluginActionError>(
        {
          error: 'Plugin mutation already in progress',
          pluginId: id,
          ...(holder ? { lockHolder: holder } : {}),
        },
        409,
      );
    }

    const pluginsDir = join(resolve(hookHomeDir), '.claude', 'plugins');
    const cli = pluginCliFor(deps, hookHomeDir);

    try {
      return await pluginMutation.withLock('plugin-update', async () => {
        const backup = await pluginMutation.backupPluginsDir(pluginsDir);
        try {
          await cli.update(id);
          await backup.discard();
        } catch (err) {
          const restore = await backup.restore();
          const note = restore.ok
            ? ''
            : ` Your previous Claude plugin config is preserved at ${restore.backupPath}`;
          console.error(`[plugins] update failed id=${id} home=${hookHomeDir}: ${errorMessage(err)}`);
          return c.json<PluginActionError>({ error: `${errorMessage(err)}${note}`, pluginId: id }, 500);
        }

        // A successful update is a Kookr plugin change — advance the config epoch
        // so Kookr-managed sessions started before it surface as reload-drift.
        await epochStoreFor(deps).bump().catch((err) => {
          console.warn(`[plugins] epoch bump after update failed id=${id}: ${errorMessage(err)}`);
        });

        const plugins = await buildReadModel(deps, hookHomeDir, true);
        const plugin = plugins.find((p) => p.id === id);
        if (!plugin) {
          return c.json<PluginActionError>(
            { error: 'Plugin updated but could not be read back from the registry', pluginId: id },
            500,
          );
        }
        return c.json<PluginUpdateOutcome>({ status: 'updated', plugin });
      });
    } catch (err) {
      if (err instanceof PluginMutationBusyError) {
        return c.json<PluginActionError>(
          { error: 'Plugin mutation already in progress', pluginId: id, lockHolder: err.holder },
          409,
        );
      }
      console.error(`[plugins] update errored id=${id}: ${errorMessage(err)}`);
      return c.json<PluginActionError>({ error: errorMessage(err), pluginId: id }, 500);
    }
  });

  // --- Loadout authoring + dry-run (RFC Layer 2 / slice 2a) -----------------
  // Plugin-level only (R3a: no per-skill fields). The adapter is untouched by
  // these routes — they only read/write Kookr-owned desired state and preview a
  // resolution; injection onto the spawn path is slice 2b, behind its flag.

  app.get('/api/plugins/loadouts', async (c) => {
    try {
      const data = await loadoutStoreFor(deps).read();
      return c.json(data);
    } catch (err) {
      console.error(`[plugins] loadout read failed: ${errorMessage(err)}`);
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // Author the desired state at one scope key. An empty `plugins` map removes
  // the entry (back to no opinion at that level).
  app.put('/api/plugins/loadouts/:level/:key', async (c) => {
    const level = c.req.param('level');
    const key = c.req.param('key');
    if (!isLoadoutLevel(level)) {
      return c.json({ error: `Invalid loadout level: ${level}` }, 400);
    }
    if (!key) {
      return c.json({ error: 'Missing loadout key' }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const state = parseDesiredState(body);
    if (!state) {
      return c.json(
        { error: 'Body must be { plugins: { "<name>@<marketplace>": boolean, ... } }' },
        400,
      );
    }
    try {
      const data = await loadoutStoreFor(deps).setLevelState(level, key, state);
      return c.json(data);
    } catch (err) {
      console.error(`[plugins] loadout write failed level=${level} key=${key}: ${errorMessage(err)}`);
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // Dry-run resolve: preview the loadout a launch context would get, WITHOUT
  // spawning (RFC Layer 2 operability — "a dry-run resolve lets the operator
  // preview a loadout before spawning"). Defaults to bypass mode, the mode Kookr
  // spawns its own agents in.
  app.post('/api/plugins/loadouts/resolve', async (c) => {
    let body: { projectId?: unknown; playbookId?: unknown; taskType?: unknown; mode?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const mode: LoadoutSpawnMode = body?.mode === 'normal' ? 'normal' : 'bypass';
    const asString = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined;
    try {
      const result = await loadoutStoreFor(deps).resolveForLaunch(
        {
          projectId: asString(body?.projectId),
          playbookId: asString(body?.playbookId),
          taskType: asString(body?.taskType),
        },
        { mode },
      );
      return c.json(result);
    } catch (err) {
      console.error(`[plugins] loadout resolve failed: ${errorMessage(err)}`);
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // --- Own-session assist (RFC "Own-session assist (G3)" / R4) ---------------
  // Mutating the operator's OWN interactive sessions (distinct from loadouts,
  // which target spawned agents). The UI shows the blast-radius + /reload-plugins
  // disclosure BEFORE calling these (single source: OWN_SESSION_BLAST_RADIUS).
  // Every action serializes through the shared lock, is backed up + reversible
  // (R8), and bumps the config epoch on success.

  // Enable / disable / reset a plugin for the operator's own sessions, by an
  // inverse single-key edit of `enabledPlugins` at the chosen scope (default user).
  app.post('/api/plugins/own-session/enablement', async (c) => {
    let body: OwnSessionEnablementRequest;
    try {
      body = (await c.req.json()) as OwnSessionEnablementRequest;
    } catch {
      return c.json<OwnSessionActionError>({ error: 'Invalid JSON body' }, 400);
    }
    const pluginId = typeof body?.pluginId === 'string' ? body.pluginId : '';
    if (!pluginId.includes('@')) {
      return c.json<OwnSessionActionError>({ error: 'Invalid plugin id (expected <name>@<marketplace>)' }, 400);
    }
    if (!(body.value === true || body.value === false || body.value === null)) {
      return c.json<OwnSessionActionError>({ error: 'value must be true, false, or null (reset)' }, 400);
    }
    const scope = normalizeOwnSessionScope(body.scope);
    if (scope === null) {
      return c.json<OwnSessionActionError>({ error: `Invalid scope: ${String(body.scope)}` }, 400);
    }
    const assist = ownSessionAssistFor(deps, hookHomeDir, pluginMutation);
    try {
      const value = body.value === null ? undefined : body.value;
      const res = await assist.setEnablement(pluginId, value, scope);
      const enablement: PluginEnablement = value === undefined ? 'default' : value ? 'enabled' : 'disabled';
      return c.json<OwnSessionEnablementResult>({
        status: 'applied',
        pluginId,
        scope: scope as OwnSessionScope,
        enablement,
        previousValue: res.previousValue ?? null,
        backupPath: res.backupPath,
        epoch: res.epoch,
      });
    } catch (err) {
      console.error(`[plugins] own-session enablement failed id=${pluginId}: ${errorMessage(err)}`);
      return ownSessionErrorResponse(c, err);
    }
  });

  // Add a marketplace for the operator's own sessions.
  app.post('/api/plugins/own-session/marketplace', async (c) => {
    let body: OwnSessionMarketplaceRequest;
    try {
      body = (await c.req.json()) as OwnSessionMarketplaceRequest;
    } catch {
      return c.json<OwnSessionActionError>({ error: 'Invalid JSON body' }, 400);
    }
    const source = typeof body?.source === 'string' ? body.source.trim() : '';
    if (!source) {
      return c.json<OwnSessionActionError>({ error: 'source is required' }, 400);
    }
    const assist = ownSessionAssistFor(deps, hookHomeDir, pluginMutation);
    try {
      const { epoch } = await assist.addMarketplace(source);
      return c.json<OwnSessionActionResult>({ status: 'applied', epoch, note: OWN_SESSION_BLAST_RADIUS });
    } catch (err) {
      console.error(`[plugins] own-session add-marketplace failed source=${source}: ${errorMessage(err)}`);
      return ownSessionErrorResponse(c, err);
    }
  });

  // Install a plugin for the operator's own sessions (combined plugins+settings
  // op, R8-ordered with reverse undo). Optionally adds a marketplace first and
  // enables the plugin after install.
  app.post('/api/plugins/own-session/install', async (c) => {
    let body: OwnSessionInstallRequest;
    try {
      body = (await c.req.json()) as OwnSessionInstallRequest;
    } catch {
      return c.json<OwnSessionActionError>({ error: 'Invalid JSON body' }, 400);
    }
    const pluginId = typeof body?.pluginId === 'string' ? body.pluginId : '';
    if (!pluginId.includes('@')) {
      return c.json<OwnSessionActionError>({ error: 'Invalid plugin id (expected <name>@<marketplace>)' }, 400);
    }
    const scope = normalizeOwnSessionScope(body.scope);
    if (scope === null) {
      return c.json<OwnSessionActionError>({ error: `Invalid scope: ${String(body.scope)}` }, 400);
    }
    const marketplaceSource =
      typeof body.marketplaceSource === 'string' && body.marketplaceSource.trim()
        ? body.marketplaceSource.trim()
        : undefined;
    const assist = ownSessionAssistFor(deps, hookHomeDir, pluginMutation);
    try {
      const { epoch } = await assist.installPlugin(pluginId, {
        ...(marketplaceSource ? { marketplaceSource } : {}),
        enableAfterInstall: body.enableAfterInstall === true,
        scope,
      });
      return c.json<OwnSessionActionResult>({ status: 'applied', epoch, note: OWN_SESSION_BLAST_RADIUS });
    } catch (err) {
      console.error(`[plugins] own-session install failed id=${pluginId}: ${errorMessage(err)}`);
      return ownSessionErrorResponse(c, err);
    }
  });
}
