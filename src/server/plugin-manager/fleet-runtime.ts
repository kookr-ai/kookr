/**
 * The fleet set's server-side runtime (RFC "Plugins for the Kookr fleet",
 * slice 1). One instance per server, shared by the plugin routes, the observe
 * interval and the auto-update sweep. It owns no new persistence: the fleet set
 * is in `LoadoutStore`'s fleet file, the observed-version baseline in
 * `AutoUpdateStore`, and the last fleet check in `FleetCheckService`. What it
 * keeps in memory is the recent list of external changes to fleet plugins.
 */
import { loadoutActivation } from '../../core/claude-settings/loadout.js';
import {
  FLEET_COVERAGE_NOTE,
  type AutoUpdateExternalChange,
  type FleetExternalChange,
  type FleetStatus,
  type TaskLoadoutRecord,
} from '../../shared/contracts/plugins.js';
import type { LoadoutStore } from './loadout-store.js';
import type { FleetCheckService } from './fleet-check.js';
import type { ConfigEpochStore } from './config-epoch.js';
import type { AutoUpdateStore } from './auto-update-store.js';
import type { PluginMutationService } from './mutation-service.js';
import { observeExternalChanges, recordKookrPluginChange } from './auto-update-service.js';
import {
  registryInstalledPlugins,
  selectedInstalledVersions,
  type InstalledPlugins,
} from './registry.js';

/** The per-task view the runtime reads (live tasks only). */
export interface FleetTaskView {
  id: string;
  loadout?: TaskLoadoutRecord;
}

export interface PluginFleetRuntimeDeps {
  loadoutStore: LoadoutStore;
  check: FleetCheckService;
  epochStore: Pick<ConfigEpochStore, 'bump'>;
  autoUpdateStore: AutoUpdateStore;
  mutation: PluginMutationService;
  installedPlugins?: InstalledPlugins;
  homeDir: string;
  liveTasks: () => readonly FleetTaskView[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const MAX_REMEMBERED_CHANGES = 20;

/**
 * The live tasks that started on a different version of `change.pluginId` than
 * the one now installed: their record lists the plugin with another version.
 * Pure.
 */
export function tasksOnOtherVersion(
  change: Pick<AutoUpdateExternalChange, 'pluginId' | 'toVersion'>,
  tasks: readonly FleetTaskView[],
): string[] {
  return tasks
    .filter((t) => t.loadout?.plugins?.some((p) => p.id === change.pluginId && p.version !== change.toVersion))
    .map((t) => t.id)
    .sort();
}

export class PluginFleetRuntime {
  private changes: FleetExternalChange[] = [];
  private readonly installed: InstalledPlugins;

  constructor(private readonly deps: PluginFleetRuntimeDeps) {
    this.installed = deps.installedPlugins ?? registryInstalledPlugins(deps.homeDir);
  }

  get check(): FleetCheckService {
    return this.deps.check;
  }

  get installedPlugins(): InstalledPlugins {
    return this.installed;
  }

  /** True when the observe interval should run: whenever a first spawn would resolve a loadout. */
  observeActive(): boolean {
    return loadoutActivation(this.deps.env).firstSpawnResolves;
  }

  /**
   * Run the observe half now (interval tick or manager open) and react to what
   * it finds. Returns the number of changes, or null when the lock was busy.
   */
  async observeNow(): Promise<number | null> {
    const changes = await observeExternalChanges({
      store: this.deps.autoUpdateStore,
      mutation: this.deps.mutation,
      readInstalledVersions: async () => selectedInstalledVersions(await this.installed.read()),
    });
    if (changes && changes.length > 0) await this.onExternalChanges(changes);
    return changes === null ? null : changes.length;
  }

  /**
   * React to external version changes (R10). Only changes to a plugin the fleet
   * set enables count: bump the config epoch (so the drift surface lists the
   * sessions started before it), re-run the fleet check, and remember which
   * running tasks started on the older version.
   */
  async onExternalChanges(changes: readonly AutoUpdateExternalChange[]): Promise<void> {
    const fleet = (await this.deps.loadoutStore.readFleet()).plugins;
    const relevant = changes.filter((c) => fleet[c.pluginId] === true);
    if (relevant.length === 0) return;
    const tasks = this.deps.liveTasks();
    for (const change of relevant) {
      const entry: FleetExternalChange = { ...change, affectedTaskIds: tasksOnOtherVersion(change, tasks) };
      console.warn(
        `[fleet] ${change.pluginId} changed outside Kookr ${change.fromVersion ?? 'none'} → ${change.toVersion ?? 'none'}; ` +
          `running tasks on the older version: ${entry.affectedTaskIds.join(', ') || 'none'}`,
      );
      this.changes.unshift(entry);
    }
    this.changes = this.changes.slice(0, MAX_REMEMBERED_CHANGES);
    await this.deps.epochStore.bump().catch((err) => {
      console.warn(`[fleet] epoch bump after external change failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.deps.check.runInBackground('external-change');
  }

  /**
   * Record a Kookr-initiated plugin change in the observed baseline. Call it
   * while holding the mutation lock (as every Kookr plugin mutation does).
   */
  async recordKookrChange(
    pluginIds: readonly string[],
    opts: { previousVersions?: ReadonlyMap<string, string | null>; retries?: number; retryDelayMs?: number } = {},
  ): Promise<void> {
    // The registry can lag the CLI by a moment. When the caller knows the
    // version before its change, wait briefly until the registry moves off it.
    let current = selectedInstalledVersions(await this.installed.read());
    const previous = opts.previousVersions;
    const stale = (): boolean =>
      previous !== undefined && pluginIds.some((id) => previous.has(id) && current.get(id) === previous.get(id));
    for (let attempt = 0; attempt < (opts.retries ?? 3) && stale(); attempt++) {
      await new Promise<void>((r) => setTimeout(r, opts.retryDelayMs ?? 150));
      current = selectedInstalledVersions(await this.installed.read());
    }
    await recordKookrPluginChange(this.deps.autoUpdateStore, pluginIds, current);
  }

  /** After a Kookr plugin update: re-run the fleet check when the plugin is in the fleet set. */
  async afterKookrPluginChange(pluginId: string): Promise<void> {
    const fleet = (await this.deps.loadoutStore.readFleet()).plugins;
    if (fleet[pluginId] === true) this.deps.check.runInBackground('plugin-update');
  }

  /** Replace the fleet set: write the file (logged), bump the epoch, start a check without waiting. */
  async setFleet(plugins: Record<string, boolean>): Promise<FleetStatus> {
    await this.deps.loadoutStore.writeFleet(plugins);
    await this.deps.epochStore.bump().catch((err) => {
      console.warn(`[fleet] epoch bump after fleet change failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.deps.check.runInBackground('fleet-change');
    return this.status();
  }

  /** The fleet status read model (`GET /api/plugins/fleet`). */
  async status(): Promise<FleetStatus> {
    const fleet = await this.deps.loadoutStore.readFleet();
    const installed = await this.installed.read().catch(() => new Map());
    const namedNotInstalled = Object.entries(fleet.plugins)
      .filter(([id, on]) => on && !installed.has(id))
      .map(([id]) => id)
      .sort();
    return {
      plugins: fleet.plugins,
      fileStatus: fleet.status,
      activation: loadoutActivation(this.deps.env),
      namedNotInstalled,
      lastCheck: this.deps.check.lastResult,
      checkRunning: this.deps.check.running,
      externalChanges: [...this.changes],
      spawnGateDegradedTaskIds: this.deps
        .liveTasks()
        .filter((t) => t.loadout?.spawnGateDegraded)
        .map((t) => t.id)
        .sort(),
      coverageNote: FLEET_COVERAGE_NOTE,
    };
  }
}
