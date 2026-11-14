import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Compare dotted numeric versions (e.g. "0.4.1" vs "0.7.4"). Returns <0 if
 * a<b, 0 if equal, >0 if a>b. Missing segments compare as 0. Deliberately
 * small — toolkit plugin versions are simple `major.minor.patch` integers.
 * Canonical home (re-exported by `plugin-version-status` for compatibility).
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

/**
 * Readers for Claude Code's on-disk plugin registry files. These are the
 * documented FALLBACK behind `claude plugin list --json` (RFC Layer 0 F6): the
 * CLI is the source of truth, and these readers back the fleet read model when
 * the CLI is unavailable, plus they stay the single owner of the
 * `installed_plugins.json` version shape (one reader, not one per feature).
 *
 * Every reader is malformed-tolerant: a missing or unparseable file yields an
 * empty result, never a throw.
 */

/** One install record for a plugin (one per scope); `installed_plugins.json` v2. */
export interface InstalledPluginRecord {
  scope?: string;
  installPath?: string;
  version: string | null;
  gitCommitSha?: string | null;
}

function registryPath(homeDir: string): string {
  return join(resolve(homeDir), '.claude', 'plugins', 'installed_plugins.json');
}

async function readJson(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read all install records keyed by plugin id. Each value is `installed_plugins
 * .json`'s array of per-scope records, normalized to {@link
 * InstalledPluginRecord}. Returns an empty map on a missing/malformed file.
 */
export async function readInstalledPlugins(
  homeDir: string,
): Promise<Map<string, InstalledPluginRecord[]>> {
  const out = new Map<string, InstalledPluginRecord[]>();
  const parsed = await readJson(registryPath(homeDir));
  if (typeof parsed !== 'object' || parsed === null) return out;
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (typeof plugins !== 'object' || plugins === null) return out;
  for (const [id, entry] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue;
    const records: InstalledPluginRecord[] = entry
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map((r) => ({
        scope: typeof r.scope === 'string' ? r.scope : undefined,
        installPath: typeof r.installPath === 'string' ? r.installPath : undefined,
        version: typeof r.version === 'string' ? r.version : null,
        gitCommitSha: typeof r.gitCommitSha === 'string' ? r.gitCommitSha : null,
      }));
    out.set(id, records);
  }
  return out;
}

/**
 * The effective installed version for a plugin: the highest version across its
 * per-scope install records (if any scope is current, the user is not behind).
 * Returns null when the plugin has no versioned record. Shared single reader —
 * `plugin-version-status` delegates to it so there is one version-extraction
 * path (parity-tested).
 */
export function highestInstalledVersion(records: InstalledPluginRecord[]): string | null {
  const versions = records
    .map((r) => r.version)
    .filter((v): v is string => typeof v === 'string');
  if (versions.length === 0) return null;
  return versions.reduce((max, v) => (compareVersions(v, max) > 0 ? v : max));
}

function knownMarketplacesPath(homeDir: string): string {
  return join(resolve(homeDir), '.claude', 'plugins', 'known_marketplaces.json');
}

/**
 * The set of marketplace names registered in `known_marketplaces.json`, or
 * `null` when the file is missing/unreadable (so a caller can tell "not
 * registered" apart from "couldn't check"). A plugin whose marketplace is NOT in
 * this set cannot be acted on by marketplace-scoped commands and should degrade
 * to "open in `/plugin`" rather than erroring (RFC Edge cases — real for
 * `stripe@anthropic-plugin-directory`). Single owner of this file, like the
 * installed-plugins reader.
 */
export async function readKnownMarketplaces(homeDir: string): Promise<Set<string> | null> {
  const parsed = await readJson(knownMarketplacesPath(homeDir));
  if (typeof parsed !== 'object' || parsed === null) return null;
  return new Set(Object.keys(parsed as Record<string, unknown>));
}

/** Convenience: highest installed version for a single plugin id (registry fallback). */
export async function readInstalledVersionFromRegistry(
  homeDir: string,
  pluginId: string,
): Promise<string | null> {
  const all = await readInstalledPlugins(homeDir);
  const records = all.get(pluginId);
  if (!records) return null;
  return highestInstalledVersion(records);
}

/**
 * The narrow read port the launcher uses to ask "which plugins are installed
 * right now?" (RFC section 1, "Who filters"). Backed by a direct read of
 * `installed_plugins.json`: under a millisecond, where `claude plugin list`
 * takes about three seconds, so the spawn path never shells out. A missing or
 * malformed registry reads as empty, so every named plugin is then skipped as
 * `not_installed` (fails closed).
 */
export interface InstalledPlugins {
  read(): Promise<Map<string, InstalledPluginRecord[]>>;
}

/** The registry-file implementation of {@link InstalledPlugins} for one home directory. */
export function registryInstalledPlugins(homeDir: string): InstalledPlugins {
  return { read: () => readInstalledPlugins(homeDir) };
}

/**
 * Pick the one install record that stands for a plugin when the registry
 * holds several (one per scope): the user-scope record when there is one,
 * otherwise the record with the highest version. Null for an empty list.
 * Shared by the spawn-time filter and the external-change observer so both
 * read the same version.
 */
export function selectInstallRecord(records: readonly InstalledPluginRecord[]): InstalledPluginRecord | null {
  if (records.length === 0) return null;
  const user = records.find((r) => r.scope === 'user');
  if (user) return user;
  return records.reduce((best, r) => {
    if (r.version === null) return best;
    if (best.version === null) return r;
    return compareVersions(r.version, best.version) > 0 ? r : best;
  });
}

/** id → selected installed version for every plugin in the registry (see {@link selectInstallRecord}). */
export function selectedInstalledVersions(
  all: ReadonlyMap<string, readonly InstalledPluginRecord[]>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [id, records] of all) {
    const rec = selectInstallRecord(records);
    if (rec) out.set(id, rec.version);
  }
  return out;
}
