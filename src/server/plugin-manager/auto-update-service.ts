/**
 * AutoUpdateService — the Layer-4 fleet-aware, idle-gated, safe auto-update
 * runner (RFC Layer 4 / R6). It composes the pure idle predicate + audit state
 * machine with the P1 `PluginMutationService` lock + backup, the P3
 * `ConfigEpochStore`, and `ClaudeSettingsStore`'s `autoUpdate` dual-writer guard.
 *
 * The side-effecting primitives (`inspect`/`update`/`verify`/`snapshot`/
 * `restore`/`bumpEpoch`) are injected through {@link AutoUpdateOps} so the whole
 * decision machine is unit-testable with fakes; {@link createAutoUpdateOps}
 * wires the real CLI / filesystem / registry.
 *
 * Race safety (R6): the idle check AND the update run inside ONE
 * `mutation.withLock(...)`, and the spawn path records its loadout under the same
 * lock (see the spawn gate in `loadout-store.ts`), so no task can slip in between
 * the idle check and the update completing. An unrecorded loadout counts as
 * depending on everything, so a not-yet-spawned task is already "busy".
 */
import {
  DEFAULT_AUTO_UPDATE_POLICY,
  pluginMarketplaceFromId,
  type AutoUpdateDecision,
  type AutoUpdatePluginView,
  type AutoUpdatePolicy,
  type AutoUpdateSnapshotMeta,
  type AutoUpdateSurface,
} from '../../shared/contracts/plugins.js';
import type { PluginMutationService } from './mutation-service.js';
import type { ClaudeSettingsStore, SettingsScope } from '../../core/claude-settings/settings-store.js';
import type { AutoUpdateStore } from './auto-update-store.js';
import type { AutoUpdateAuditStore } from './auto-update-audit-store.js';
import {
  busyTasksForPlugin,
  type IdlePredicateTaskView,
} from '../../core/plugin-auto-update/idle-predicate.js';
import { nextAutoUpdateState, type AutoUpdateState } from '../../core/plugin-auto-update/state-machine.js';
import { detectExternalChanges, effectiveAutoUpdateForPlugin } from '../../core/plugin-auto-update/defaults.js';

/** Fresh inspection of a plugin's versions + install dir. `behind: null` ⇒ could not check. */
export interface AutoUpdateInspection {
  installedVersion: string | null;
  availableVersion: string | null;
  behind: boolean | null;
  installPath: string | null;
}

/** The side-effecting primitives the runner drives (injectable for tests). */
export interface AutoUpdateOps {
  inspect(pluginId: string): Promise<AutoUpdateInspection>;
  /** Run `claude plugin update <id>` through the shared lock + backup. Throws on failure. */
  update(pluginId: string): Promise<void>;
  /** Confirm the updated plugin loads (present + readable). */
  verify(pluginId: string): Promise<boolean>;
  /** Capture a scoped pre-update snapshot; null when not snapshottable. */
  snapshot(pluginId: string, installPath: string, fromVersion: string | null): Promise<AutoUpdateSnapshotMeta | null>;
  /** Restore a scoped snapshot (rollback). */
  restore(meta: AutoUpdateSnapshotMeta): Promise<{ ok: boolean; snapshotPath?: string }>;
  /** Delete a snapshot directory on disk (best-effort) — superseded or past its window. */
  discard(snapshotPath: string): Promise<void>;
  /** Bump the P3 config epoch (returns the new epoch). */
  bumpEpoch(): Promise<number>;
}

export interface AutoUpdateServiceDeps {
  store: AutoUpdateStore;
  audit: AutoUpdateAuditStore;
  mutation: PluginMutationService;
  settings: ClaudeSettingsStore;
  ops: AutoUpdateOps;
  /** Non-terminal task views for the idle predicate (read INSIDE the lock). */
  getTasks: () => IdlePredicateTaskView[] | Promise<IdlePredicateTaskView[]>;
  /** All installed versions id→version for external-change detection. */
  readInstalledVersions: () => Promise<Map<string, string | null>>;
  /** Default-off env gate: when false, `apply-when-idle` degrades to notify-only (never auto-applies). */
  applyEnabled: boolean;
  now?: () => Date;
  settingsScope?: SettingsScope;
}

export class AutoUpdateService {
  private readonly now: () => Date;
  private readonly scope: SettingsScope;

  constructor(private readonly deps: AutoUpdateServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.scope = deps.settingsScope ?? 'user';
  }

  get applyEnabled(): boolean {
    return this.deps.applyEnabled;
  }

  /**
   * Set a plugin's policy and reconcile the native per-marketplace
   * `autoUpdate` dual-writer guard: Kookr writes `autoUpdate:false` while ANY
   * plugin in a marketplace is `apply-when-idle`, and REVERTS (removes its key)
   * once none is. Runs under the shared lock so the settings write serializes
   * with every other mutation. Returns the plugin's refreshed view.
   */
  async setPolicy(pluginId: string, policy: AutoUpdatePolicy): Promise<AutoUpdatePluginView> {
    await this.deps.mutation.withLock('plugin-auto-update-policy', async () => {
      await this.deps.store.setPolicy(pluginId, policy);
      await this.reconcileMarketplaceAutoUpdate(pluginMarketplaceFromId(pluginId));
    });
    return this.viewFor(pluginId);
  }

  /**
   * Ensure the per-marketplace `autoUpdate` flag matches whether Kookr owns the
   * update decision for any plugin in `marketplace`, WITHOUT clobbering an
   * operator's own explicit flag. Kookr tracks ownership provenance: on takeover
   * it records the value it found and pins `false`; on release it restores EXACTLY
   * that recorded value (absent → removes the key → native default; `true`/`false`
   * → rewrites the operator's own value). It never touches a flag it did not take
   * over. Called while holding the mutation lock; the settings store gets an
   * identity `withLock`.
   */
  private async reconcileMarketplaceAutoUpdate(marketplace: string | null): Promise<void> {
    if (marketplace === null) return;
    const data = await this.deps.store.read();
    const anyApplyWhenIdle = Object.entries(data.policies).some(
      ([id, p]) => p === 'apply-when-idle' && pluginMarketplaceFromId(id) === marketplace,
    );
    const owned = data.autoUpdateOwnership[marketplace]; // undefined ⇒ Kookr does not own the flag
    const writeFlag = (value: boolean | undefined): Promise<unknown> =>
      this.deps.settings.writeAutoUpdate(marketplace, value, { scope: this.scope, withLock: (fn) => fn() });

    try {
      if (anyApplyWhenIdle) {
        if (!owned) {
          // Take over: record what was there first, then pin `false` (only write
          // if it is not already false, so we never make a redundant edit).
          const before = await this.deps.settings.readAutoUpdate(marketplace); // boolean | undefined
          await this.deps.store.update((d) => {
            d.autoUpdateOwnership[marketplace] = { previousValue: before ?? null };
          });
          if (before !== false) await writeFlag(false);
        } else {
          // Already owned: self-heal if an external writer flipped it off `false`.
          const current = await this.deps.settings.readAutoUpdate(marketplace);
          if (current !== false) await writeFlag(false);
        }
      } else if (owned) {
        // Release: restore EXACTLY the value Kookr found before taking over.
        await writeFlag(owned.previousValue === null ? undefined : owned.previousValue);
        await this.deps.store.update((d) => {
          delete d.autoUpdateOwnership[marketplace];
        });
      }
      // Not apply-when-idle and not owned ⇒ Kookr never touched it; leave it alone.
    } catch (err) {
      console.warn(
        `[auto-update] autoUpdate reconcile failed for ${marketplace}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Evaluate ONE plugin end-to-end under the shared lock and write its audit
   * decision. The idle check and the update run inside the same lock. `manual`
   * marks an operator-triggered "run now" (allows evaluating a plugin whose
   * policy is not `apply-when-idle`, recording `policy-off`).
   */
  async evaluatePlugin(pluginId: string, opts: { manual?: boolean } = {}): Promise<AutoUpdateDecision> {
    return this.deps.mutation.withLock('plugin-auto-update', async () => {
      const decision = await this.evaluateUnderLock(pluginId, opts);
      await this.deps.audit.append(decision);
      return decision;
    });
  }

  /** The decision machine (assumes the lock is held). Side effects via `ops`. */
  private async evaluateUnderLock(
    pluginId: string,
    opts: { manual?: boolean },
  ): Promise<AutoUpdateDecision> {
    const evaluatedAt = this.now().toISOString();
    const policy = await this.deps.store.getPolicy(pluginId);
    let state: AutoUpdateState = 'evaluating';

    const skip = (reason: AutoUpdateDecision['reason'], extra: Partial<AutoUpdateDecision> = {}): AutoUpdateDecision => {
      state = nextAutoUpdateState(state, 'skip');
      return { pluginId, evaluatedAt, policy, state: 'skipped', reason, ...extra };
    };

    // Only `apply-when-idle` auto-applies; everything else is a policy-off skip.
    if (policy !== 'apply-when-idle') {
      return skip('policy-off');
    }
    // The default-off env gate degrades apply-when-idle to notify-only.
    if (!this.deps.applyEnabled && !opts.manual) {
      return skip('policy-off', { detail: 'auto-apply disabled (KOOKR_PLUGIN_AUTO_UPDATE off)' });
    }

    const inspection = await this.deps.ops.inspect(pluginId);
    if (inspection.behind === null) {
      return skip('check-failed', { fromVersion: inspection.installedVersion });
    }
    if (!inspection.behind) {
      return skip('no-update', { fromVersion: inspection.installedVersion, toVersion: inspection.availableVersion });
    }
    const busy = busyTasksForPlugin(pluginId, await this.deps.getTasks());
    if (busy.length > 0) {
      return skip('busy', { busyTaskIds: busy, fromVersion: inspection.installedVersion });
    }

    // Proceed to apply.
    state = nextAutoUpdateState(state, 'proceed'); // applying
    const fromVersion = inspection.installedVersion;
    const toVersion = inspection.availableVersion;

    // Capture a scoped, retained snapshot BEFORE the update (rollback target).
    let snapshotMeta: AutoUpdateSnapshotMeta | null = null;
    if (inspection.installPath) {
      try {
        snapshotMeta = await this.deps.ops.snapshot(pluginId, inspection.installPath, fromVersion);
      } catch (err) {
        console.warn(`[auto-update] snapshot failed for ${pluginId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Persist the NEW snapshot meta BEFORE the update (and before discarding the
    // superseded dir), so a crash mid-update leaves `store.snapshots` pointing at
    // a snapshot that actually exists on disk — then discard the superseded dir.
    if (snapshotMeta) {
      let supersededPath: string | null = null;
      await this.deps.store.update((d) => {
        const prev = d.snapshots[pluginId];
        if (prev && prev.snapshotPath !== snapshotMeta!.snapshotPath) supersededPath = prev.snapshotPath;
        d.snapshots[pluginId] = snapshotMeta!;
      });
      if (supersededPath) await this.deps.ops.discard(supersededPath).catch(() => undefined);
    }

    try {
      await this.deps.ops.update(pluginId);
    } catch (err) {
      state = nextAutoUpdateState(state, 'apply-error'); // failed
      // Undo a partial update if we have a snapshot (hygiene; snapshot stays retained in the store).
      if (snapshotMeta) await this.deps.ops.restore(snapshotMeta).catch(() => undefined);
      return { pluginId, evaluatedAt, policy, state: 'failed', fromVersion, toVersion, detail: errText(err) };
    }

    state = nextAutoUpdateState(state, 'apply-ok'); // verifying
    const loads = await this.deps.ops.verify(pluginId).catch(() => false);
    if (loads) {
      state = nextAutoUpdateState(state, 'verify-ok'); // applied
      const epoch = await this.deps.ops.bumpEpoch().catch(() => -1);
      await this.deps.store.update((d) => {
        // Retain the snapshot for the window; refresh observed; clear any old banner.
        if (snapshotMeta) d.snapshots[pluginId] = snapshotMeta;
        d.observed[pluginId] = toVersion ?? fromVersion;
        delete d.banners[pluginId];
      });
      return {
        pluginId,
        evaluatedAt,
        policy,
        state: 'applied',
        fromVersion,
        toVersion,
        detail: epoch >= 0 ? `config epoch bumped to ${epoch}` : undefined,
      };
    }

    // Verify failed → record it distinctly, then roll back.
    state = nextAutoUpdateState(state, 'verify-fail'); // verify-failed
    if (!snapshotMeta) {
      // Nothing to roll back to — drop to notify and raise a banner naming the gap.
      await this.deps.store.update((d) => {
        d.policies[pluginId] = 'notify';
        d.banners[pluginId] = {
          pluginId,
          kind: 'verify-failed',
          message: `Auto-update of ${pluginId} to ${toVersion ?? 'the new version'} did not load and could not be rolled back (no snapshot). Policy dropped to notify.`,
          raisedAt: this.now().toISOString(),
        };
      });
      await this.reconcileMarketplaceAutoUpdate(pluginMarketplaceFromId(pluginId));
      return { pluginId, evaluatedAt, policy, state: 'verify-failed', fromVersion, toVersion, detail: 'new version did not load; no snapshot to roll back to' };
    }

    const restore = await this.deps.ops.restore(snapshotMeta);
    if (restore.ok) {
      state = nextAutoUpdateState(state, 'restore-ok'); // rolled-back
      await this.deps.store.update((d) => {
        d.policies[pluginId] = 'notify';
        d.observed[pluginId] = fromVersion;
        d.snapshots[pluginId] = snapshotMeta!;
        d.banners[pluginId] = {
          pluginId,
          kind: 'verify-failed',
          message: `Auto-update of ${pluginId} to ${toVersion ?? 'the new version'} did not load; rolled back to ${fromVersion ?? 'the previous version'}. Policy dropped to notify.`,
          raisedAt: this.now().toISOString(),
        };
      });
      await this.reconcileMarketplaceAutoUpdate(pluginMarketplaceFromId(pluginId));
      return { pluginId, evaluatedAt, policy, state: 'rolled-back', fromVersion, toVersion, detail: 'verify failed; scoped rollback succeeded' };
    }

    state = nextAutoUpdateState(state, 'restore-fail'); // rollback-failed
    await this.deps.store.update((d) => {
      d.policies[pluginId] = 'notify';
      d.snapshots[pluginId] = snapshotMeta!;
      d.banners[pluginId] = {
        pluginId,
        kind: 'rollback-failed',
        message: `Auto-update of ${pluginId} did not load AND the rollback failed. Your pre-update snapshot is preserved; restore it manually.`,
        raisedAt: this.now().toISOString(),
        ...(restore.snapshotPath ? { snapshotPath: restore.snapshotPath } : {}),
      };
    });
    await this.reconcileMarketplaceAutoUpdate(pluginMarketplaceFromId(pluginId));
    return { pluginId, evaluatedAt, policy, state: 'rollback-failed', fromVersion, toVersion, detail: `verify failed; rollback failed (snapshot at ${restore.snapshotPath ?? snapshotMeta.snapshotPath})` };
  }

  /**
   * Operator-initiated rollback of a plugin to its retained snapshot (RFC Layer
   * 4 — scoped + retained). Because sessions may already have started on the new
   * version, this bumps the config epoch and raises a `post-session` banner so
   * the restart prompt surfaces via the config-epoch drift surface. Records an
   * audit decision.
   */
  async rollback(pluginId: string): Promise<AutoUpdateDecision> {
    return this.deps.mutation.withLock('plugin-auto-update-rollback', async () => {
      const evaluatedAt = this.now().toISOString();
      const policy = await this.deps.store.getPolicy(pluginId);
      const data = await this.deps.store.read();
      const meta = data.snapshots[pluginId];
      if (!meta) {
        const decision: AutoUpdateDecision = { pluginId, evaluatedAt, policy, state: 'failed', detail: 'no retained snapshot to roll back to' };
        await this.deps.audit.append(decision);
        return decision;
      }
      const restore = await this.deps.ops.restore(meta);
      const epoch = restore.ok ? await this.deps.ops.bumpEpoch().catch(() => -1) : -1;
      await this.deps.store.update((d) => {
        if (restore.ok) {
          d.observed[pluginId] = meta.fromVersion;
          d.banners[pluginId] = {
            pluginId,
            kind: 'post-session',
            message: `Rolled ${pluginId} back to ${meta.fromVersion ?? 'the previous version'}. Sessions started on the newer version need a restart (see the drift panel).`,
            raisedAt: this.now().toISOString(),
          };
        } else {
          d.banners[pluginId] = {
            pluginId,
            kind: 'rollback-failed',
            message: `Rollback of ${pluginId} failed. Your snapshot is preserved; restore it manually.`,
            raisedAt: this.now().toISOString(),
            ...(restore.snapshotPath ? { snapshotPath: restore.snapshotPath } : {}),
          };
        }
      });
      const decision: AutoUpdateDecision = {
        pluginId,
        evaluatedAt,
        policy,
        state: restore.ok ? 'rolled-back' : 'rollback-failed',
        fromVersion: null,
        toVersion: meta.fromVersion,
        detail: restore.ok ? (epoch >= 0 ? `rolled back; config epoch bumped to ${epoch}` : 'rolled back') : 'rollback failed',
      };
      await this.deps.audit.append(decision);
      return decision;
    });
  }

  /**
   * Periodic sweep: evaluate every `apply-when-idle` plugin, detect external
   * version changes across the fleet, and prune expired snapshots. Safe to call
   * on an interval.
   */
  async runSweep(): Promise<{ decisions: AutoUpdateDecision[]; externalChanges: number }> {
    const data = await this.deps.store.read();
    const applyWhenIdle = Object.entries(data.policies)
      .filter(([, p]) => p === 'apply-when-idle')
      .map(([id]) => id);

    const decisions: AutoUpdateDecision[] = [];
    const kookrChanged = new Set<string>();
    for (const id of applyWhenIdle) {
      const decision = await this.evaluatePlugin(id, { manual: false });
      decisions.push(decision);
      if (decision.state === 'applied' || decision.state === 'rolled-back') kookrChanged.add(id);
    }

    // Run the detect-baseline + snapshot-prune store writes UNDER the shared lock,
    // like every other store mutation, so they cannot interleave with a lock-held
    // evaluate/rollback's read-modify-write and lose an update.
    const externalChanges = await this.deps.mutation.withLock('plugin-auto-update-sweep', async () => {
      const n = await this.detectAndLogExternalChanges(kookrChanged);
      await this.pruneExpiredSnapshots();
      return n;
    });
    return { decisions, externalChanges };
  }

  /** Diff fleet installed versions vs last-observed, log external changes, update the baseline. */
  async detectAndLogExternalChanges(kookrChanged: ReadonlySet<string> = new Set()): Promise<number> {
    const current = await this.deps.readInstalledVersions();
    const data = await this.deps.store.read();
    const changes = detectExternalChanges(data.observed, current, { kookrChanged, now: this.now().toISOString() });
    for (const change of changes) {
      console.log(
        `[auto-update] external_change plugin=${change.pluginId} ` +
          `from=${change.fromVersion ?? 'none'} to=${change.toVersion ?? 'none'} at=${change.detectedAt}`,
      );
    }
    // Persist the fresh baseline for every observed plugin (incl. first sightings).
    await this.deps.store.update((d) => {
      for (const [id, v] of current) d.observed[id] = v;
    });
    return changes.length;
  }

  /** Remove snapshot metadata AND the on-disk snapshot dir past the retention window. */
  private async pruneExpiredSnapshots(): Promise<void> {
    const nowIso = this.now().toISOString();
    const expired = Object.values((await this.deps.store.read()).snapshots).filter(
      (meta) => meta.retainUntil < nowIso,
    );
    for (const meta of expired) {
      await this.deps.ops.discard(meta.snapshotPath).catch(() => undefined);
    }
    if (expired.length === 0) return;
    await this.deps.store.update((d) => {
      for (const meta of expired) delete d.snapshots[meta.pluginId];
    });
  }

  /** The effective native `autoUpdate` for a plugin's marketplace (explicit flag, else documented default — read, not assumed). */
  private async nativeAutoUpdateFor(pluginId: string): Promise<boolean> {
    const marketplace = pluginMarketplaceFromId(pluginId);
    const explicit = marketplace === null ? undefined : await this.deps.settings.readAutoUpdate(marketplace);
    return effectiveAutoUpdateForPlugin(pluginId, explicit);
  }

  /** Assemble the per-plugin view (policy + last decision + banner + rollback availability). */
  async viewFor(pluginId: string): Promise<AutoUpdatePluginView> {
    const [data, lastDecision, nativeAutoUpdate] = await Promise.all([
      this.deps.store.read(),
      this.deps.audit.lastFor(pluginId),
      this.nativeAutoUpdateFor(pluginId),
    ]);
    return {
      pluginId,
      policy: data.policies[pluginId] ?? DEFAULT_AUTO_UPDATE_POLICY,
      lastDecision,
      banner: data.banners[pluginId] ?? null,
      rollbackAvailable: Boolean(data.snapshots[pluginId]),
      nativeAutoUpdate,
    };
  }

  /** Assemble the whole fleet auto-update surface for the dialog. */
  async getSurface(pluginIds: readonly string[]): Promise<AutoUpdateSurface> {
    const data = await this.deps.store.read();
    const ids = new Set<string>(pluginIds);
    // Include any plugin that has stored state even if it is not in the current fleet.
    for (const id of Object.keys(data.policies)) ids.add(id);
    for (const id of Object.keys(data.banners)) ids.add(id);
    const recent = await this.deps.audit.recent(50);
    const lastByPlugin = new Map<string, AutoUpdateDecision>();
    for (const d of recent) if (!lastByPlugin.has(d.pluginId)) lastByPlugin.set(d.pluginId, d);
    // Read each distinct marketplace's `autoUpdate` once (not per plugin).
    const autoUpdateByMarket = new Map<string, boolean | undefined>();
    for (const id of ids) {
      const m = pluginMarketplaceFromId(id);
      if (m !== null && !autoUpdateByMarket.has(m)) {
        autoUpdateByMarket.set(m, await this.deps.settings.readAutoUpdate(m));
      }
    }
    const plugins: AutoUpdatePluginView[] = [...ids].sort().map((id) => {
      const m = pluginMarketplaceFromId(id);
      return {
        pluginId: id,
        policy: data.policies[id] ?? DEFAULT_AUTO_UPDATE_POLICY,
        lastDecision: lastByPlugin.get(id) ?? null,
        banner: data.banners[id] ?? null,
        rollbackAvailable: Boolean(data.snapshots[id]),
        nativeAutoUpdate: effectiveAutoUpdateForPlugin(id, m === null ? undefined : autoUpdateByMarket.get(m)),
      };
    });
    return { plugins, recentDecisions: recent, applyEnabled: this.deps.applyEnabled };
  }

  /** Dismiss a persistent banner (operator acknowledged it). */
  async dismissBanner(pluginId: string): Promise<void> {
    await this.deps.store.update((d) => {
      delete d.banners[pluginId];
    });
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.message];
    if ('stderr' in err && typeof (err as { stderr?: unknown }).stderr === 'string') {
      const s = (err as { stderr: string }).stderr.trim();
      if (s) parts.push(s);
    }
    return parts.join('\n');
  }
  return String(err);
}
