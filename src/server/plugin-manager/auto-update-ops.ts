/**
 * Real-dependency wiring for {@link AutoUpdateOps} (RFC Layer 4). Separated from
 * the pure decision machine in `auto-update-service.ts` so the service stays
 * unit-testable with fakes. The ops here reuse the P1 seams: `ClaudePluginCli`
 * for the update + load check, the fleet read model for staleness, the registry
 * reader for the install path, the scoped-snapshot helpers for rollback, and the
 * P3 `ConfigEpochStore` for the epoch bump.
 *
 * NOTE on the lock: these ops run while `AutoUpdateService.evaluatePlugin`
 * already holds the one `PluginMutationService` lock, so `update()` must NOT
 * re-acquire it (that would deadlock the single-threaded lock). The scoped
 * snapshot is the "backup" half of "lock + backup".
 */
import type { ClaudePluginCli } from './cli.js';
import type { ClaudeSettingsStore } from '../../core/claude-settings/settings-store.js';
import type { ConfigEpochStore } from './config-epoch.js';
import { assembleManagedPlugins } from './read-model.js';
import { readInstalledPlugins } from './registry.js';
import {
  captureScopedSnapshot,
  restoreScopedSnapshot,
  discardSnapshot,
  DEFAULT_SNAPSHOT_RETENTION_MS,
} from './auto-update-snapshots.js';
import type { AutoUpdateOps, AutoUpdateInspection } from './auto-update-service.js';
import type { AutoUpdateSnapshotMeta } from '../../shared/contracts/plugins.js';

export interface CreateAutoUpdateOpsDeps {
  cli: ClaudePluginCli;
  settings: ClaudeSettingsStore;
  configEpochStore: ConfigEpochStore;
  homeDir: string;
  /** Kookr data dir — snapshots live under it. */
  dataDir: string;
  /** Git-sourced available version for the toolkit (from origin/main), or null. */
  toolkitAvailable: { pluginId: string; availableVersion: string | null } | null;
  retentionMs?: number;
  now?: () => Date;
}

/** The highest-version install record's install path for a plugin, or null. */
async function resolveInstallPath(homeDir: string, pluginId: string): Promise<string | null> {
  const all = await readInstalledPlugins(homeDir);
  const records = all.get(pluginId);
  if (!records || records.length === 0) return null;
  // Prefer a record that actually has an install path; fall back to the first.
  const withPath = records.find((r) => typeof r.installPath === 'string');
  return withPath?.installPath ?? null;
}

export function createAutoUpdateOps(deps: CreateAutoUpdateOpsDeps): AutoUpdateOps {
  const retentionMs = deps.retentionMs ?? DEFAULT_SNAPSHOT_RETENTION_MS;
  const now = deps.now ?? (() => new Date());

  return {
    async inspect(pluginId: string): Promise<AutoUpdateInspection> {
      const [rows, installPath] = await Promise.all([
        assembleManagedPlugins({
          cli: deps.cli,
          settings: deps.settings,
          homeDir: deps.homeDir,
          toolkitAvailable: deps.toolkitAvailable,
          fetchTokens: false,
        }),
        resolveInstallPath(deps.homeDir, pluginId),
      ]);
      const row = rows.find((r) => r.id === pluginId);
      if (!row) {
        return { installedVersion: null, availableVersion: null, behind: null, installPath };
      }
      const behind =
        row.staleness.state === 'behind' ? true : row.staleness.state === 'current' ? false : null;
      return {
        installedVersion: row.installedVersion,
        availableVersion: row.availableVersion,
        behind,
        installPath,
      };
    },

    async update(pluginId: string): Promise<void> {
      await deps.cli.update(pluginId);
    },

    async verify(pluginId: string): Promise<boolean> {
      // "Loads" proxy: the plugin is still present in `claude plugin list --json`
      // with a readable version after the update.
      const records = await deps.cli.list();
      return records.some((r) => r.id === pluginId && r.version !== null);
    },

    async snapshot(pluginId, installPath, fromVersion): Promise<AutoUpdateSnapshotMeta | null> {
      try {
        const snapshotPath = await captureScopedSnapshot(deps.dataDir, pluginId, installPath, now().getTime());
        const takenAt = now();
        return {
          pluginId,
          installPath,
          snapshotPath,
          fromVersion,
          takenAt: takenAt.toISOString(),
          retainUntil: new Date(takenAt.getTime() + retentionMs).toISOString(),
        };
      } catch {
        return null; // install dir missing / copy failed — not snapshottable
      }
    },

    async restore(meta): Promise<{ ok: boolean; snapshotPath?: string }> {
      return restoreScopedSnapshot(meta.snapshotPath, meta.installPath);
    },

    async discard(snapshotPath: string): Promise<void> {
      await discardSnapshot(snapshotPath);
    },

    async bumpEpoch(): Promise<number> {
      return deps.configEpochStore.bump();
    },
  };
}
