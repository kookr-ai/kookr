/**
 * Wiring for the Layer-4 auto-update runner (RFC Layer 4). Builds a fully-wired
 * {@link AutoUpdateService} from the common route/server deps, reusing the P1
 * seams (CLI, settings store, read model) and the shared `PluginMutationService`
 * lock so the runner, the plugin routes, and the spawn gate all serialize
 * through ONE lock. Used by both the HTTP routes and the background sweep in
 * `index.ts`, so they share identical construction.
 */
import { homedir } from 'node:os';
import type { DeployRouteDeps } from '../routes/shared.js';
import { resolveToolkitAvailable } from '../routes/deploy-routes.js';
import { PluginMutationService } from './mutation-service.js';
import { ClaudePluginCli, execFilePluginCliRunner } from './cli.js';
import { ClaudeSettingsStore, defaultScopeFiles } from '../../core/claude-settings/settings-store.js';
import { ConfigEpochStore } from './config-epoch.js';
import { assembleManagedPlugins } from './read-model.js';
import { AutoUpdateStore } from './auto-update-store.js';
import { AutoUpdateAuditStore } from './auto-update-audit-store.js';
import { createAutoUpdateOps } from './auto-update-ops.js';
import { autoUpdateApplyEnabled } from './auto-update-flags.js';
import { AutoUpdateService } from './auto-update-service.js';
import type { TaskStore } from '../../core/tasks.js';
import type { IdlePredicateTaskView } from '../../core/plugin-auto-update/idle-predicate.js';

/** Deps the auto-update wiring needs: the deploy/plugin deps plus task access for the idle predicate. */
export interface AutoUpdateWiringDeps extends DeployRouteDeps {
  taskStore: Pick<TaskStore, 'viewLiveTasks'>;
}

const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

/** Build a fully-wired AutoUpdateService. Also returns the current fleet plugin ids for the surface. */
export async function buildAutoUpdateService(
  deps: AutoUpdateWiringDeps,
): Promise<{ service: AutoUpdateService; fleetPluginIds: () => Promise<string[]> }> {
  const hookHomeDir = deps.hookHomeDir ?? homedir();
  const dataDir = deps.kookrDir ?? deps.serverCwd;
  const bin = deps.pluginUpdateBin ?? process.env.KOOKR_AGENT_BIN ?? 'claude';

  const cli = new ClaudePluginCli(execFilePluginCliRunner(bin, { ...gitEnv, HOME: hookHomeDir }));
  const settings = new ClaudeSettingsStore(defaultScopeFiles(deps.serverCwd, hookHomeDir));
  const configEpochStore = new ConfigEpochStore(dataDir);
  const store = new AutoUpdateStore(dataDir);
  const audit = new AutoUpdateAuditStore(dataDir);
  const mutation = deps.pluginMutationService ?? new PluginMutationService();
  const toolkitAvailable = await resolveToolkitAvailable(deps);

  const ops = createAutoUpdateOps({
    cli,
    settings,
    configEpochStore,
    homeDir: hookHomeDir,
    dataDir,
    toolkitAvailable,
  });

  const getTasks = (): IdlePredicateTaskView[] =>
    deps.taskStore.viewLiveTasks().map((t) => ({ id: t.id, isTerminal: false, loadout: t.loadout }));

  const readInstalledVersions = async (): Promise<Map<string, string | null>> => {
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: hookHomeDir,
      toolkitAvailable,
      fetchTokens: false,
    });
    return new Map(rows.map((r) => [r.id, r.installedVersion]));
  };

  const service = new AutoUpdateService({
    store,
    audit,
    mutation,
    settings,
    ops,
    getTasks,
    readInstalledVersions,
    applyEnabled: autoUpdateApplyEnabled(),
  });

  const fleetPluginIds = async (): Promise<string[]> => {
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: hookHomeDir,
      toolkitAvailable,
      fetchTokens: false,
    });
    return rows.map((r) => r.id);
  };

  return { service, fleetPluginIds };
}
