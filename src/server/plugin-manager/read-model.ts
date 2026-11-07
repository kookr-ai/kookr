import type { ManagedPlugin } from '../../shared/contracts/plugins.js';
import type { ClaudePluginCli } from './cli.js';
import type { ClaudeSettingsStore } from '../../core/claude-settings/settings-store.js';
import { readInstalledPlugins, highestInstalledVersion, compareVersions } from './registry.js';
import { gitStaleness, catalogStalenessUnknown } from './version-source.js';

/**
 * Plugin ids whose prefix Kookr depends on — `uninstallGuard` is server-set so
 * the toolkit is never offered a one-click uninstall (RFC Edge cases / F7).
 */
const UNINSTALL_GUARDED_PREFIXES = ['kookr-toolkit@'];

function isUninstallGuarded(id: string): boolean {
  return UNINSTALL_GUARDED_PREFIXES.some((p) => id.startsWith(p));
}

export interface AssembleReadModelSources {
  cli: ClaudePluginCli;
  settings: ClaudeSettingsStore;
  /** Home dir for the on-disk registry fallback when the CLI returns nothing. */
  homeDir: string;
  /** Git-sourced available version for the toolkit (from origin/main), or null. */
  toolkitAvailable: { pluginId: string; availableVersion: string | null } | null;
  /** When true, fetch `claude plugin details` per plugin for the always-on token cost. */
  fetchTokens?: boolean;
  /** Injectable clock for deterministic `observedAt` in tests. */
  now?: () => Date;
}

/**
 * Assemble the fleet read model: one {@link ManagedPlugin} row per installed
 * plugin (RFC Layer 1). The registry source of truth is `claude plugin list
 * --json`; on CLI failure it falls back to the on-disk registry. Enablement is
 * resolved as tri-state via `ClaudeSettingsStore` (absent ≠ false) — never the
 * CLI's collapsed `enabled` boolean. Rows are sorted by id for stable output.
 */
export async function assembleManagedPlugins(
  sources: AssembleReadModelSources,
): Promise<ManagedPlugin[]> {
  const observedAt = (sources.now?.() ?? new Date()).toISOString();

  // Installed id → highest installed version. Prefer the CLI; fall back to disk.
  const installed = new Map<string, string | null>();
  const cliRecords = await sources.cli.list();
  if (cliRecords.length > 0) {
    for (const r of cliRecords) {
      // A plugin can appear once per scope; keep the highest version seen.
      const prev = installed.get(r.id);
      if (prev === undefined) {
        installed.set(r.id, r.version);
      } else if (r.version && (prev === null || compareVersions(r.version, prev) > 0)) {
        installed.set(r.id, r.version);
      }
    }
  } else {
    const registry = await readInstalledPlugins(sources.homeDir);
    for (const [id, records] of registry) {
      installed.set(id, highestInstalledVersion(records));
    }
  }

  const toolkitId = sources.toolkitAvailable?.pluginId ?? null;
  const rows: ManagedPlugin[] = [];
  for (const [id, installedVersion] of installed) {
    const enablement = (await sources.settings.resolveEnablement(id)).state;
    const alwaysOnTokens = sources.fetchTokens ? (await sources.cli.details(id)).alwaysOnTokens : null;

    const isToolkit = toolkitId !== null && id === toolkitId;
    const availableVersion = isToolkit ? (sources.toolkitAvailable?.availableVersion ?? null) : null;
    const staleness = isToolkit
      ? gitStaleness(installedVersion, availableVersion, observedAt)
      : catalogStalenessUnknown(observedAt);

    rows.push({
      id,
      installedVersion,
      availableVersion,
      enablement,
      staleness,
      loadSource: 'marketplace',
      alwaysOnTokens,
      uninstallGuard: isUninstallGuarded(id),
    });
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}
