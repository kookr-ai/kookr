import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface PluginVersionStatus {
  /** Marketplace plugin identifier, e.g. "kookr-toolkit@kookr". */
  pluginId: string;
  /** Version recorded in ~/.claude/plugins/installed_plugins.json, or null if not installed via the marketplace. */
  installedVersion: string | null;
  /** Latest published version (from origin/main's plugin manifest), or null if unknown. */
  availableVersion: string | null;
  /** True when a marketplace install exists and is strictly behind the available version. */
  stale: boolean;
}

interface InstalledPluginRecord {
  version?: unknown;
}

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
  const installedVersion = await readInstalledVersion(options.homeDir, options.pluginId);
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

async function readInstalledVersion(homeDir: string, pluginId: string): Promise<string | null> {
  const registryPath = join(resolve(homeDir), '.claude', 'plugins', 'installed_plugins.json');
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch {
    return null; // no registry / not installed via the marketplace
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const records = extractRecords(parsed, pluginId);
  // A plugin may carry multiple install records (one per scope). Treat the
  // highest installed version as effective: if any install is current, the
  // user is not behind.
  const versions = records
    .map((r) => (typeof r.version === 'string' ? r.version : null))
    .filter((v): v is string => v !== null);
  if (versions.length === 0) return null;
  return versions.reduce((max, v) => (compareVersions(v, max) > 0 ? v : max));
}

function extractRecords(parsed: unknown, pluginId: string): InstalledPluginRecord[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (typeof plugins !== 'object' || plugins === null) return [];
  const entry = (plugins as Record<string, unknown>)[pluginId];
  if (!Array.isArray(entry)) return [];
  return entry.filter((r): r is InstalledPluginRecord => typeof r === 'object' && r !== null);
}

/**
 * Compare dotted numeric versions (e.g. "0.4.1" vs "0.7.4"). Returns <0 if
 * a<b, 0 if equal, >0 if a>b. Missing segments compare as 0. Deliberately
 * small — plugin versions are simple `major.minor.patch` integers with no
 * pre-release tags.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? '0', 10) || 0;
    const nb = parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
