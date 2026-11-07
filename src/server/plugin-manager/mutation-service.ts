import { access, cp, rename, rm } from 'node:fs/promises';

/**
 * Describes who currently holds the plugin mutation lock. Surfaced in the 409
 * body so an operator can see which operation is blocking theirs (R8).
 */
export interface PluginMutationHolder {
  /** Short operation label, e.g. "plugin-install" / "plugin-update". */
  operation: string;
  /** ISO-8601 timestamp of when the holder acquired the lock. */
  startedAt: string;
}

/**
 * Thrown by {@link PluginMutationService.withLock} when another mutation is
 * already in flight. The {@link holder} names the operation + start time so the
 * route can render a 409 that identifies the blocker (R8: "the lock's 409 SHALL
 * name the holder, operation, and start time").
 */
export class PluginMutationBusyError extends Error {
  constructor(public readonly holder: PluginMutationHolder) {
    super(
      `Plugin mutation already in progress: ${holder.operation} (since ${holder.startedAt})`,
    );
    this.name = 'PluginMutationBusyError';
  }
}

/**
 * A backup of `~/.claude/plugins` taken before a mutation, with the
 * restore/discard semantics the install route has always used (extracted
 * verbatim from `deploy-routes.ts` in slice 1a — no behaviour change).
 */
export interface PluginsDirBackup {
  /** Whether the plugins dir existed when the backup was taken. */
  readonly existedBefore: boolean;
  /** Absolute path of the backup copy, or null when there was nothing to back up. */
  readonly backupPath: string | null;
  /**
   * Restore the plugins dir to its pre-mutation state. Returns `{ ok: true }`
   * on success, or `{ ok: false, backupPath }` when the original config could
   * not be fully restored (caller should surface `backupPath` so the user can
   * recover manually).
   */
  restore(): Promise<{ ok: boolean; backupPath?: string }>;
  /** Delete the backup after a successful mutation (best-effort). */
  discard(): Promise<void>;
}

/**
 * Owns the single process-wide lock and backup helper for every operation that
 * mutates `~/.claude/plugins/`. Extracted out of the `deploy-routes.ts` closure
 * (where `pluginMutating` was an unshareable `let`) so that the deploy routes,
 * the new plugin routes, and the future Layer-4 auto-update runner all serialize
 * through one lock (RFC Layer 0 / R8).
 *
 * Intentionally dependency-free and synchronous about the lock: because the
 * runtime is single-threaded, the check-then-set in {@link withLock} is atomic
 * with respect to concurrent request handlers — exactly the guarantee the old
 * boolean provided.
 */
export class PluginMutationService {
  private holder: PluginMutationHolder | null = null;

  /** The current lock holder, or null when the lock is free. */
  get currentHolder(): PluginMutationHolder | null {
    return this.holder;
  }

  /** True while a mutation is in flight. */
  get isLocked(): boolean {
    return this.holder !== null;
  }

  /**
   * Run `fn` while holding the mutation lock. Throws {@link
   * PluginMutationBusyError} immediately (without running `fn`) if another
   * mutation holds the lock. The lock is always released when `fn` settles.
   */
  async withLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    if (this.holder !== null) {
      throw new PluginMutationBusyError(this.holder);
    }
    this.holder = { operation, startedAt: new Date().toISOString() };
    try {
      return await fn();
    } finally {
      this.holder = null;
    }
  }

  /**
   * Back up the plugins directory before a mutation. Mirrors the install
   * route's historical behaviour exactly: when the dir does not exist, no copy
   * is made and `restore()` simply removes whatever the mutation created; when
   * it exists, a timestamped sibling copy is made and `restore()` moves the
   * partial aside, restores the backup, then removes the partial.
   */
  async backupPluginsDir(pluginsDir: string): Promise<PluginsDirBackup> {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    const backupPath = `${pluginsDir}.kookr-install-backup-${ts}-${process.pid}-${rand}`;
    let existedBefore = false;
    try {
      await access(pluginsDir);
      existedBefore = true;
      await cp(pluginsDir, backupPath, { recursive: true });
    } catch {
      // plugins dir doesn't exist yet — no backup needed; record that fact.
      existedBefore = false;
    }

    const restore = async (): Promise<{ ok: boolean; backupPath?: string }> => {
      if (!existedBefore) {
        // Dir did not exist before the mutation — just remove what was created.
        await rm(pluginsDir, { recursive: true, force: true });
        return { ok: true };
      }

      // Dir existed before: move the partial aside first, THEN restore the backup.
      const partialDir = `${pluginsDir}.kookr-failed-${Date.now()}`;
      try {
        // Step 1: move the failed/partial mutation out of the way (if it exists).
        try {
          await rename(pluginsDir, partialDir);
        } catch {
          // pluginsDir may not exist at all (mutation errored before creating it) — fine.
        }
        // Step 2: restore the backup into the canonical location.
        await rename(backupPath, pluginsDir);
        // Step 3: remove the partial (best-effort; backup is already restored).
        await rm(partialDir, { recursive: true, force: true });
        return { ok: true };
      } catch (restoreErr) {
        console.error(`[plugin-mutation] backup restore failed: ${String(restoreErr)}`);
        // The original config is still in backupPath — tell the caller.
        return { ok: false, backupPath };
      }
    };

    const discard = async (): Promise<void> => {
      if (!existedBefore) return;
      try {
        await rm(backupPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    };

    return {
      existedBefore,
      backupPath: existedBefore ? backupPath : null,
      restore,
      discard,
    };
  }
}
