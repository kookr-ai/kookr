import { readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * ClaudeSettingsStore — the single owner of Claude Code's *scoped* settings
 * files (user / user-local / project / project-local). RFC Layer 0 / R7.
 *
 * Pure with respect to locking: it takes **no** lock of its own. A caller that
 * mutates passes a `withLock(fn)` so the one module-owned
 * `PluginMutationService` lock serializes settings writes against plugins-dir
 * writes. The store owns three keys — `enabledPlugins`, `permissions.deny`, and
 * `extraKnownMarketplaces[*].autoUpdate` — and nothing else parses their format.
 *
 * Tri-state is load-bearing: a plugin absent from every scope's
 * `enabledPlugins` is `default` (native default), NOT `disabled`. Reads are
 * malformed-tolerant: a missing or unparseable file is skipped, never thrown.
 */

/** The settings scopes Claude Code reads, highest precedence first. */
export type SettingsScope = 'projectLocal' | 'project' | 'userLocal' | 'user';

/** Resolved tri-state enablement for a plugin. */
export type Enablement = 'enabled' | 'disabled' | 'default';

export interface EnablementResolution {
  state: Enablement;
  /** The scope whose explicit boolean decided it, when not `default`. */
  decidedBy?: SettingsScope;
}

export interface ScopeFile {
  scope: SettingsScope;
  path: string;
}

/** Minimal shape of a Claude Code settings file (only keys the store owns). */
interface SettingsFileData {
  enabledPlugins?: Record<string, unknown>;
  permissions?: { deny?: unknown; allow?: unknown };
  extraKnownMarketplaces?: Record<string, { autoUpdate?: unknown }>;
}

interface LoadedScope {
  scope: SettingsScope;
  path: string;
  data: SettingsFileData;
}

/**
 * Thrown when the target settings file changed on disk between the read and the
 * write (a terminal `/plugin` or `claude plugin enable` that does not take the
 * Kookr lock). Named loudly so the route can 409 (RFC Edge cases / R8).
 */
export class ConcurrentSettingsWriteError extends Error {
  constructor(public readonly path: string) {
    super(`Settings file changed under the lock before write: ${path}`);
    this.name = 'ConcurrentSettingsWriteError';
  }
}

/**
 * Build the scope → path list in Claude Code's documented precedence order
 * (highest first): project-local, project, user-local, user. Mirrors the files
 * `ralph-plugin-coexistence` scans, but keyed by scope.
 */
export function defaultScopeFiles(cwd: string, home: string = homedir()): ScopeFile[] {
  return [
    { scope: 'projectLocal', path: join(cwd, '.claude', 'settings.local.json') },
    { scope: 'project', path: join(cwd, '.claude', 'settings.json') },
    { scope: 'userLocal', path: join(home, '.claude', 'settings.local.json') },
    { scope: 'user', path: join(home, '.claude', 'settings.json') },
  ];
}

/**
 * Resolve a plugin's tri-state enablement from scopes in precedence order
 * (highest first). The first scope with an explicit boolean for the plugin
 * wins; if none has one, the result is `default`. Pure — exported for tests.
 */
export function resolveEnablementFromScopes(
  scopesHighestFirst: Array<{ scope: SettingsScope; enabledPlugins?: Record<string, unknown> }>,
  pluginId: string,
): EnablementResolution {
  for (const { scope, enabledPlugins } of scopesHighestFirst) {
    const value = enabledPlugins?.[pluginId];
    if (value === true) return { state: 'enabled', decidedBy: scope };
    if (value === false) return { state: 'disabled', decidedBy: scope };
  }
  return { state: 'default' };
}

/**
 * Apply an inverse single-key edit to `enabledPlugins`: set the plugin's
 * boolean when `value` is a boolean, or remove the key entirely when `value` is
 * `undefined` (restoring the tri-state `default`). Returns a NEW object; never
 * mutates the input, and leaves every other key untouched (R8: never a
 * whole-file rewrite of unrelated keys). Pure — exported for tests.
 */
export function applyEnabledPluginEdit(
  current: SettingsFileData,
  pluginId: string,
  value: boolean | undefined,
): SettingsFileData {
  const next: SettingsFileData = { ...current };
  const map: Record<string, unknown> = { ...(current.enabledPlugins ?? {}) };
  if (value === undefined) {
    delete map[pluginId];
  } else {
    map[pluginId] = value;
  }
  if (Object.keys(map).length === 0) {
    delete next.enabledPlugins;
  } else {
    next.enabledPlugins = map;
  }
  return next;
}

function parseSettings(raw: string): SettingsFileData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return parsed as SettingsFileData;
}

export interface WriteEnablementResult {
  path: string;
  /** The plugin's boolean before the edit, or `undefined` when it was absent (default). */
  previousValue: boolean | undefined;
  /** Where the pre-write backup copy was written, or null when the file did not exist. */
  backupPath: string | null;
}

export class ClaudeSettingsStore {
  constructor(private readonly scopeFiles: ScopeFile[]) {}

  /** Load every scope, skipping missing/malformed files (never throws). */
  private async loadScopes(): Promise<LoadedScope[]> {
    const loaded: LoadedScope[] = [];
    for (const { scope, path } of this.scopeFiles) {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        continue; // missing file — skip
      }
      const data = parseSettings(raw);
      if (data === null) continue; // malformed — skip
      loaded.push({ scope, path, data });
    }
    return loaded;
  }

  /** Resolve a plugin's tri-state enablement across all scopes (precedence-ordered). */
  async resolveEnablement(pluginId: string): Promise<EnablementResolution> {
    const scopes = await this.loadScopes();
    return resolveEnablementFromScopes(
      scopes.map(({ scope, data }) => ({ scope, enabledPlugins: data.enabledPlugins })),
      pluginId,
    );
  }

  /**
   * The effective `permissions.deny` list, collected across scopes (union).
   * Returns only string entries; malformed entries are dropped.
   */
  async readDenies(): Promise<string[]> {
    const scopes = await this.loadScopes();
    const out = new Set<string>();
    for (const { data } of scopes) {
      const deny = data.permissions?.deny;
      if (Array.isArray(deny)) {
        for (const d of deny) if (typeof d === 'string') out.add(d);
      }
    }
    return [...out];
  }

  /**
   * Read the per-marketplace `autoUpdate` flag from `extraKnownMarketplaces`,
   * resolving across scopes (highest precedence first). Returns `undefined`
   * when no scope sets it — the caller then applies the documented default
   * (ON for official/claude.ai, OFF for others) rather than assuming the key
   * exists (R6 / Edge cases).
   */
  async readAutoUpdate(marketplace: string): Promise<boolean | undefined> {
    const scopes = await this.loadScopes();
    for (const { data } of scopes) {
      const entry = data.extraKnownMarketplaces?.[marketplace];
      const value = entry?.autoUpdate;
      if (typeof value === 'boolean') return value;
    }
    return undefined;
  }

  /**
   * Inverse single-key write of `enabledPlugins[pluginId]` at the given scope,
   * lock-agnostic: the caller passes `withLock` so the one module-owned lock
   * serializes this write against plugins-dir mutations (R7). The sequence,
   * under the lock:
   *
   *   1. read + hash the target file;
   *   2. back it up (copy aside) before any write;
   *   3. re-read immediately before writing and assert the hash is unchanged —
   *      fail loudly ({@link ConcurrentSettingsWriteError}) on a concurrent
   *      writer (R8 / Edge cases);
   *   4. apply the single-key edit and write atomically (temp + rename).
   *
   * Returns the previous value so the caller can undo with an inverse edit
   * (never a whole-file restore).
   */
  async writeEnablement(
    pluginId: string,
    value: boolean | undefined,
    opts: { scope: SettingsScope; withLock: <T>(fn: () => Promise<T>) => Promise<T> },
  ): Promise<WriteEnablementResult> {
    const target = this.scopeFiles.find((s) => s.scope === opts.scope);
    if (!target) {
      throw new Error(`Unknown settings scope: ${opts.scope}`);
    }
    const path = target.path;

    // Snapshot the file the edit is based on, OUTSIDE the lock. Its hash is the
    // baseline the in-lock guard asserts against.
    const before = await readTarget(path);

    return opts.withLock(async () => {
      // Concurrent-writer guard (R8 / Edge cases): re-read under the lock and
      // fail loudly if the file changed since the snapshot — a terminal
      // /plugin or `claude plugin enable` that does not take the Kookr lock.
      const guard = await readTarget(path);
      if (guard.hash !== before.hash) {
        throw new ConcurrentSettingsWriteError(path);
      }

      const current = guard.data ?? {};
      const previousRaw = current.enabledPlugins?.[pluginId];
      const previousValue = typeof previousRaw === 'boolean' ? previousRaw : undefined;

      // Back up before writing (R8). Nothing to back up when the file is absent.
      let backupPath: string | null = null;
      if (guard.exists) {
        backupPath = `${path}.kookr-settings-backup-${Date.now()}-${process.pid}`;
        await copyFile(path, backupPath);
      }

      const next = applyEnabledPluginEdit(current, pluginId, value);
      await atomicWriteJson(path, next);
      return { path, previousValue, backupPath };
    });
  }
}

interface ReadTargetResult {
  exists: boolean;
  /** SHA-256 of the raw bytes, or null when the file does not exist. */
  hash: string | null;
  data: SettingsFileData | null;
}

async function readTarget(path: string): Promise<ReadTargetResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { exists: false, hash: null, data: null };
  }
  const hash = createHash('sha256').update(raw).digest('hex');
  return { exists: true, hash, data: parseSettings(raw) };
}

async function atomicWriteJson(path: string, data: SettingsFileData): Promise<void> {
  const tmp = `${path}.kookr-tmp-${Date.now()}-${process.pid}`;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmp, serialized, 'utf8');
  await rename(tmp, path);
}

/** Exposed for tests that assert mtime semantics without touching internals. */
export async function fileMtimeMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}
