/**
 * Own-session assist (RFC "Own-session assist (G3)" / R4).
 *
 * Mutates the operator's OWN interactive Claude Code sessions — install /
 * add-marketplace / enable-disable — by composing the P1 Layer-0 seams; it owns
 * NO new config-format knowledge of its own (parity with native `/plugin`). All
 * format knowledge stays in `ClaudePluginCli` (plugins dir) and
 * `ClaudeSettingsStore` (scoped settings files). Every mutation:
 *   - serializes through the one module-owned {@link PluginMutationService} lock;
 *   - is backed up before the write and reversible (R8);
 *   - bumps the config epoch AFTER success, so a failed/rolled-back change never
 *     advances it (RFC "Surfacing reload drift").
 *
 * This is distinct from P2 loadouts (which target Kookr-SPAWNED agents via the
 * per-session `--settings` file): here we edit the SCOPED settings files that the
 * operator's own `claude` sessions read.
 */
import type { ClaudePluginCli } from './cli.js';
import type { PluginMutationService } from './mutation-service.js';
import type { ConfigEpochStore } from './config-epoch.js';
import type { ClaudeSettingsStore, SettingsScope } from '../../core/claude-settings/settings-store.js';

/**
 * Raised when an own-session mutation fails after its plugins-dir / settings
 * edits were (attempted to be) rolled back. `restoredOk` is false when the
 * plugins dir could not be fully restored — `backupPath` then names where the
 * operator's previous config is preserved (R8: surface the backup path).
 */
export class OwnSessionMutationError extends Error {
  constructor(
    message: string,
    public readonly restoredOk: boolean,
    public readonly backupPath?: string,
  ) {
    super(message);
    this.name = 'OwnSessionMutationError';
  }
}

export interface OwnSessionDeps {
  cli: ClaudePluginCli;
  settings: ClaudeSettingsStore;
  mutation: PluginMutationService;
  epoch: ConfigEpochStore;
  /** `~/.claude/plugins` for the operator's own config. */
  pluginsDir: string;
  /**
   * Optional post-install check (the CLI can exit 0 without the install
   * landing). Returns true when `pluginId` is present in the registry. A false
   * result rolls the combined install back in reverse. Omitted in unit tests
   * that don't need verification.
   */
  verifyInstalled?: (pluginId: string) => Promise<boolean>;
}

export interface EnablementChange {
  /** The key's value before this edit (for an inverse single-key undo); undefined = it was at native default. */
  previousValue: boolean | undefined;
  backupPath: string | null;
  /** The config epoch after the change. */
  epoch: number;
}

export class OwnSessionAssist {
  constructor(private readonly deps: OwnSessionDeps) {}

  /**
   * Enable / disable / reset a plugin for the operator's own sessions by an
   * INVERSE single-key edit of `enabledPlugins` at `scope` (R8: never a
   * whole-file rewrite). `value === undefined` removes the key (back to native
   * default). The store takes the shared lock (via `withLock`) and asserts the
   * file is unchanged under it. Bumps the epoch on success.
   */
  async setEnablement(
    pluginId: string,
    value: boolean | undefined,
    scope: SettingsScope,
  ): Promise<EnablementChange> {
    // Hold the one lock across BOTH the settings write and the epoch bump, so the
    // bump is serialized with every other mutation's bump (no read-modify-write
    // race on the counter). The store gets an identity `withLock` — we already
    // hold the lock — but its TOCTOU hash guard still runs.
    return this.deps.mutation.withLock('own-session-enablement', async () => {
      const res = await this.deps.settings.writeEnablement(pluginId, value, { scope, withLock: (fn) => fn() });
      const epoch = await this.deps.epoch.bump();
      return { previousValue: res.previousValue, backupPath: res.backupPath, epoch };
    });
  }

  /**
   * Undo a prior {@link setEnablement} by writing back its `previousValue`
   * (R8 inverse single-key edit — restores the exact prior key state, leaving
   * every unrelated key the operator may have added in the interval untouched).
   */
  async undoEnablement(
    pluginId: string,
    previousValue: boolean | undefined,
    scope: SettingsScope,
  ): Promise<{ epoch: number }> {
    return this.deps.mutation.withLock('own-session-enablement-undo', async () => {
      await this.deps.settings.writeEnablement(pluginId, previousValue, { scope, withLock: (fn) => fn() });
      return { epoch: await this.deps.epoch.bump() };
    });
  }

  /**
   * Add a marketplace for the operator's own sessions (`claude plugin
   * marketplace add <source>`), under the shared lock + a plugins-dir backup;
   * restores the backup on failure. Bumps the epoch (inside the lock) on success.
   */
  async addMarketplace(source: string): Promise<{ epoch: number }> {
    return this.deps.mutation.withLock('own-session-add-marketplace', async () => {
      const backup = await this.deps.mutation.backupPluginsDir(this.deps.pluginsDir);
      try {
        await this.deps.cli.marketplaceAdd(source);
        await backup.discard();
      } catch (err) {
        const restore = await backup.restore();
        throw new OwnSessionMutationError(
          errorText(err),
          restore.ok,
          restore.ok ? undefined : restore.backupPath,
        );
      }
      return { epoch: await this.deps.epoch.bump() };
    });
  }

  /**
   * Install a plugin for the operator's own sessions. A COMBINED plugins-dir +
   * settings mutation ordered per R8: snapshot/back up settings → mutate the
   * plugins dir → mutate settings; undo IN REVERSE (revert the settings key,
   * then restore the plugins dir). Holds the lock once for the whole op and
   * passes the settings store an identity `withLock` so it does not try to
   * re-acquire the lock we already hold. Bumps the epoch on success.
   */
  async installPlugin(
    pluginId: string,
    opts: { marketplaceSource?: string; enableAfterInstall?: boolean; scope?: SettingsScope } = {},
  ): Promise<{ epoch: number; enabled: boolean }> {
    const scope = opts.scope ?? 'user';
    const enableAfter = opts.enableAfterInstall ?? false;

    return this.deps.mutation.withLock('own-session-install', async () => {
      const backup = await this.deps.mutation.backupPluginsDir(this.deps.pluginsDir);
      // Track the settings inverse so a failure AFTER the settings write undoes
      // the key first, then the plugins dir (R8 "undo in reverse"). `null` until
      // the settings stage commits.
      let settingsInverse: (() => Promise<void>) | null = null;
      try {
        // Stage 1 — mutate the plugins dir (ordered BEFORE settings).
        if (opts.marketplaceSource) await this.deps.cli.marketplaceAdd(opts.marketplaceSource);
        await this.deps.cli.install(pluginId);
        // Stage 2 — mutate settings (ordered LAST). Identity lock: we already
        // hold the mutation lock, so the store must not re-acquire it.
        if (enableAfter) {
          const res = await this.deps.settings.writeEnablement(pluginId, true, {
            scope,
            withLock: (fn) => fn(),
          });
          settingsInverse = async () => {
            await this.deps.settings.writeEnablement(pluginId, res.previousValue, {
              scope,
              withLock: (fn) => fn(),
            });
          };
        }
        // Stage 3 — confirm the plugin actually installed (the CLI can exit 0
        // without the install landing). A failure here triggers the full
        // reverse undo: revert the settings key, then restore the plugins dir.
        if (this.deps.verifyInstalled) {
          const ok = await this.deps.verifyInstalled(pluginId);
          if (!ok) throw new Error(`Plugin ${pluginId} did not appear installed after the install command`);
        }
        // Success — the plugins backup is no longer needed.
        await backup.discard();
      } catch (err) {
        // Undo in reverse (R8): revert the settings key first, then the plugins dir.
        if (settingsInverse) {
          try {
            await settingsInverse();
          } catch (undoErr) {
            console.warn(`[own-session] settings inverse-undo failed: ${errorText(undoErr)}`);
          }
        }
        const restore = await backup.restore();
        throw new OwnSessionMutationError(
          errorText(err),
          restore.ok,
          restore.ok ? undefined : restore.backupPath,
        );
      }
      // Bump inside the lock (after a confirmed success) so the counter is never
      // read-modify-written concurrently with another mutation's bump.
      return { epoch: await this.deps.epoch.bump(), enabled: enableAfter };
    });
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    if ('stderr' in err && typeof err.stderr === 'string' && err.stderr.trim()) {
      parts.push(err.stderr.trim());
    }
    return parts.join('\n');
  }
  return String(err);
}
