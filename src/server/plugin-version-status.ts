import type { PluginVersionStatus } from '../shared/contracts/plugin-version.js';
import {
  compareVersions,
  readInstalledVersionFromRegistry,
} from './plugin-manager/registry.js';

export type { PluginVersionStatus };

// Re-exported for compatibility: the canonical implementation now lives in the
// shared plugin registry reader (RFC Layer 0 — one version-extraction path).
export { compareVersions };

/**
 * Compare the marketplace-installed kookr-toolkit plugin version against the
 * latest published version so the TopBar update affordance can nudge the
 * maintainer to run `/plugin marketplace update`. Claude Code's marketplace
 * install never auto-updates and is sourced from GitHub, so the cached plugin
 * silently drifts behind the local source; this surfaces that drift.
 *
 * Pure with respect to git: callers pass `availableVersion` (read from
 * origin/main); this only reads the Claude Code plugin registry on disk.
 */
export async function getPluginVersionStatus(options: {
  homeDir: string;
  pluginId: string;
  availableVersion: string | null;
}): Promise<PluginVersionStatus> {
  const installedVersion = await readInstalledVersionFromRegistry(options.homeDir, options.pluginId);
  const stale =
    installedVersion !== null &&
    options.availableVersion !== null &&
    compareVersions(installedVersion, options.availableVersion) < 0;
  return {
    pluginId: options.pluginId,
    installedVersion,
    availableVersion: options.availableVersion,
    stale,
  };
}

