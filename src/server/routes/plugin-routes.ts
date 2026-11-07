import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Hono } from 'hono';
import type { DeployRouteDeps } from './shared.js';
import { resolveToolkitAvailable } from './deploy-routes.js';
import { PluginMutationService, PluginMutationBusyError } from '../plugin-manager/mutation-service.js';
import { ClaudePluginCli, execFilePluginCliRunner } from '../plugin-manager/cli.js';
import { assembleManagedPlugins } from '../plugin-manager/read-model.js';
import { ClaudeSettingsStore, defaultScopeFiles } from '../../core/claude-settings/settings-store.js';
import type {
  ManagedPlugin,
  PluginsReadModel,
  PluginUpdateOutcome,
  PluginActionError,
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
      const plugins = await buildReadModel(deps, hookHomeDir, true);
      return c.json<PluginsReadModel>({ plugins });
    } catch (err) {
      // Degrade, don't 500: an empty fleet is a legible "nothing installed" state.
      console.error(`[plugins] read model failed home=${hookHomeDir}: ${errorMessage(err)}`);
      return c.json<PluginsReadModel>({ plugins: [] });
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
}
