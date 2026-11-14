/**
 * LoadoutStore — the single Kookr-owned persistence for plugin loadouts
 * (RFC Layer 2 / slice 2a). Settles the RFC open question "per-project file vs
 * a store table, and how it versions": ONE versioned JSON file under the Kookr
 * data dir, with a map per scope level. A single file (not per-project files
 * scattered under each checkout) keeps authoring, dry-run, and resolution
 * reading one source of truth, and versions explicitly via a top-level
 * `version` field so a future shape change is a migration, not a guess.
 *
 * The store is desired-state only (intent). Resolution into a typed
 * `ResolvedLoadout` is the pure {@link resolveLoadout} in core; this class just
 * reads/writes the per-level maps and offers a convenience that resolves for a
 * launch context. Reads are malformed-tolerant: a missing or unparseable file
 * resolves to empty, never throws (a loadout store that 500s must not be able
 * to block a spawn).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '../../core/persistence-utils.js';
import { nowISO } from '../../core/interaction-log.js';
import {
  resolveLoadout,
  loadoutActivation,
  mostSpecificLevel,
} from '../../core/claude-settings/loadout.js';
import {
  emptyResolvedLoadout,
  pluginNameFromId,
  type LoadoutDesiredState,
  type LoadoutGivenPlugin,
  type LoadoutLevel,
  type LoadoutSkippedPlugin,
  type LoadoutSpawnMode,
  type ResolvedLoadout,
  type ResolvedLoadoutProvenance,
  type ScopedLoadoutLevel,
  type TaskLoadoutRecord,
} from '../../shared/contracts/plugins.js';
import { SCOPED_LOADOUT_LEVELS } from '../../shared/contracts/plugins.js';
import type { Task } from '../../core/task-read-model.js';
import type { TaskStore } from '../../core/tasks.js';
import { PluginMutationBusyError, type PluginMutationService } from './mutation-service.js';
import { autoUpdateApplyEnabled } from './auto-update-flags.js';
import {
  registryInstalledPlugins,
  selectInstallRecord,
  type InstalledPluginRecord,
  type InstalledPlugins,
} from './registry.js';

/**
 * Whether the spawn gate's flag arms are on: loadouts resolve for first spawns,
 * or auto-update apply is enabled. The loadout arm now also requires that a
 * loadout will actually be recorded (see {@link prepareSpawnLoadout}), so with
 * nothing configured a spawn takes no lock.
 */
export function spawnGateActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadoutActivation(env).firstSpawnResolves || autoUpdateApplyEnabled(env);
}

/** What the spawn gate tells the guarded step: whether it runs without the lock. */
export interface SpawnGateContext {
  /** True when the lock stayed busy past the deadline and the step runs without it. */
  degraded: boolean;
}

/**
 * Run the loadout RECORD step under the shared `PluginMutationService` lock so a
 * concurrent Layer-4 auto-update cannot interleave its idle-check-and-update with
 * a task committing a dependency on a plugin (RFC Layer 4 — "the spawn path
 * re-checks under the lock"). The updater holds the same lock across its whole
 * idle-check → update, so this record either lands before the updater's in-lock
 * task read (⇒ the updater sees the task as busy) or after the update completes
 * (⇒ the task launches against the new version).
 *
 * The lock is fail-fast, so a spawn waits for an in-flight mutation by retrying
 * for up to `timeoutMs` (a running update SHOULD block a new launch that might
 * use the plugin); past the deadline it proceeds WITHOUT the gate and tells the
 * step so (`degraded: true`), which marks it on the task record. A no-op when
 * `mutation` is absent or the gate is inactive.
 */
export async function withSpawnGate<T>(
  mutation: PluginMutationService | undefined,
  active: boolean,
  fn: (gate: SpawnGateContext) => Promise<T>,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  if (!mutation || !active) return fn({ degraded: false });
  const timeoutMs = opts.timeoutMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await mutation.withLock('spawn-loadout-record', () => fn({ degraded: false }));
    } catch (err) {
      if (!(err instanceof PluginMutationBusyError)) throw err;
      if (Date.now() >= deadline) {
        console.warn(
          '[spawn-gate] plugin mutation lock busy past the deadline; proceeding without the gate',
        );
        return fn({ degraded: true });
      }
      await sleep(50);
    }
  }
}

/** The adapter-launch-option fields a loadout contributes. Merged into opts at every launch site. */
export interface LoadoutLaunchOptionFields {
  resolvedLoadout?: ResolvedLoadout;
  onLoadoutApplied?: (applied: { settingsHash: string; settingsPath: string }) => void;
}

/** A resolution result as {@link resolveLoadout} returns it. */
export type LoadoutResolution = ReturnType<typeof resolveLoadout>;

/** Output of {@link partitionByInstalled}. */
export interface InstalledPartition {
  /** The loadout to hand the agent: only installed plugins enabled. */
  loadout: ResolvedLoadout;
  /** Provenance recomputed over the kept entries only. */
  provenance: ResolvedLoadoutProvenance;
  plugins: LoadoutGivenPlugin[];
  skipped: LoadoutSkippedPlugin[];
}

/**
 * The "installed only" rule (RFC R3), one pure step after resolution and before
 * recording. For each resolved entry:
 *
 * - a plugin the adapter loads with `--plugin-dir` (matched by NAME, e.g. the
 *   bundled toolkit) passes through untouched — the renderer rewrites it to
 *   `<name>@inline`, which is how a project disables the toolkit;
 * - a `false` entry passes through (disabling never needs an install);
 * - a `true` entry is kept only when the registry has an install record for
 *   it; it is then listed in `plugins` with the version and install path of
 *   the selected record ({@link selectInstallRecord}); otherwise it goes to
 *   `skipped` as `not_installed`.
 *
 * The bypass allowlist and the winning level are recomputed over what was
 * kept, so provenance never names a level whose only entries were skipped.
 */
export function partitionByInstalled(
  resolution: LoadoutResolution,
  installed: ReadonlyMap<string, readonly InstalledPluginRecord[]>,
  dirLoadedPluginNames: readonly string[] = [],
): InstalledPartition {
  const dirNames = new Set(dirLoadedPluginNames);
  const kept: Record<string, boolean> = {};
  const keptLevels: LoadoutLevel[] = [];
  const plugins: LoadoutGivenPlugin[] = [];
  const skipped: LoadoutSkippedPlugin[] = [];
  for (const [id, value] of Object.entries(resolution.loadout.enabledOverrides)) {
    const level = resolution.pluginLevels[id];
    const keep = (): void => {
      kept[id] = value;
      if (level) keptLevels.push(level);
    };
    if (dirNames.has(pluginNameFromId(id)) || value === false) {
      keep();
      continue;
    }
    const record = selectInstallRecord(installed.get(id) ?? []);
    if (!record) {
      skipped.push({ id, reason: 'not_installed' });
      continue;
    }
    keep();
    plugins.push({ id, version: record.version, installPath: record.installPath ?? null });
  }
  const mode = resolution.provenance.mode;
  const loadout: ResolvedLoadout = { ...emptyResolvedLoadout(), enabledOverrides: kept };
  if (mode === 'bypass') {
    loadout.enabledSet = Object.entries(kept)
      .filter(([, v]) => v === true)
      .map(([id]) => id)
      .sort();
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id));
  skipped.sort((a, b) => a.id.localeCompare(b.id));
  return { loadout, provenance: { winningLevel: mostSpecificLevel(keptLevels), mode }, plugins, skipped };
}

/** Shared deps for the first-spawn and replay loadout steps. */
export interface SpawnLoadoutDeps {
  loadoutStore?: LoadoutStore;
  taskStore: Pick<TaskStore, 'setLoadout'>;
  /** Installed-plugins port; defaults to the registry under the server's home directory. */
  installedPlugins?: InstalledPlugins;
  /** Names of the plugins the adapter loads with `--plugin-dir` (the bundled toolkit). */
  dirLoadedPluginNames?: () => Promise<readonly string[]>;
  /** The shared plugin mutation lock (the spawn gate). */
  mutation?: PluginMutationService;
  env?: NodeJS.ProcessEnv;
  /** How long the record step waits for a busy lock (default 5 s). */
  spawnGateTimeoutMs?: number;
}

async function readInstalledSafe(deps: SpawnLoadoutDeps): Promise<Map<string, InstalledPluginRecord[]>> {
  try {
    return await (deps.installedPlugins ?? registryInstalledPlugins(homedir())).read();
  } catch {
    return new Map(); // fail closed: every named plugin is skipped as not_installed
  }
}

async function dirNamesSafe(deps: SpawnLoadoutDeps): Promise<readonly string[]> {
  try {
    return (await deps.dirLoadedPluginNames?.()) ?? [];
  } catch {
    return [];
  }
}

/**
 * Replay the loadout recorded on a task, for every resume-like launch (resume,
 * crash recovery, Ralph relaunch, re-promotion). A resumed agent gets the
 * recorded ids, never a fresh resolution, so editing or emptying the fleet set
 * never changes what a resume gets (R4). Only the kill switch stops replay
 * (`resumeReplays`); since the adapter no longer reads the flag, THIS is where
 * an explicit `KOOKR_PLUGIN_LOADOUTS=0` takes effect on resume.
 *
 * The replay does not filter. It runs the same installed partition for
 * reporting only and stores what is gone as `replaySkipped`, so a resumed task
 * whose plugin was uninstalled says so. Returns no field (byte-identical
 * settings) when the task has no record or replay is off.
 */
export async function replayRecordedLoadout(
  deps: Omit<SpawnLoadoutDeps, 'loadoutStore' | 'mutation'> | undefined,
  task: Task,
): Promise<LoadoutLaunchOptionFields> {
  const record = task.loadout;
  if (!record) return {};
  if (!loadoutActivation(deps?.env).resumeReplays) return {};
  if (deps) {
    try {
      const report = partitionByInstalled(
        { loadout: record.resolved, provenance: { winningLevel: record.winningLevel, mode: record.mode }, pluginLevels: {} },
        await readInstalledSafe(deps),
        await dirNamesSafe(deps),
      );
      for (const s of report.skipped) {
        console.warn(`[loadout] task ${task.id} resumes with ${s.id}, which is no longer installed (${s.reason})`);
      }
      deps.taskStore.setLoadout(task.id, { ...record, replaySkipped: report.skipped, replayedAt: nowISO() });
    } catch (err) {
      console.warn(
        `[loadout] replay report failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { resolvedLoadout: record.resolved };
}

/**
 * Derive the loadout for a FIRST spawn (a direct launch, or the promotion of
 * an admission-parked task) — the launcher's single loadout decision.
 *
 * 1. A task that already carries a record is replayed ({@link replayRecordedLoadout}).
 * 2. A task with no record that has run before (it has sessions: a reopened
 *    or relaunched task) is treated as a resume of "nothing recorded": it gets
 *    no loadout rather than a fresh resolution, so turning on or editing the
 *    fleet set never changes what a resume gets (R4).
 * 3. Otherwise, when a first spawn resolves (`KOOKR_PLUGIN_LOADOUTS=1`), the
 *    agent is claude-code and a store is wired, resolve the four levels. This
 *    reads only Kookr's two small files and takes no lock.
 * 4. If any level named any plugin, take the spawn gate, read the registry,
 *    apply {@link partitionByInstalled} and ALWAYS record — including when
 *    every named plugin was skipped, the case most worth seeing.
 *
 * With nothing configured, no lock is taken (unless auto-update apply is on,
 * whose arm of the gate is unchanged) and no field is returned, so the written
 * settings stay byte-identical.
 */
export async function prepareSpawnLoadout(
  deps: SpawnLoadoutDeps,
  task: Task,
): Promise<LoadoutLaunchOptionFields> {
  if (task.loadout) return replayRecordedLoadout(deps, task);
  const env = deps.env ?? process.env;
  const resolution = await resolveFirstSpawn(deps, task, env);
  const autoUpdateArm = autoUpdateApplyEnabled(env);
  if (!resolution && !autoUpdateArm) return {};
  return withSpawnGate(
    deps.mutation,
    true,
    async (gate) => (resolution ? recordFirstSpawn(deps, task, resolution, gate) : {}),
    deps.spawnGateTimeoutMs !== undefined ? { timeoutMs: deps.spawnGateTimeoutMs } : {},
  );
}

async function resolveFirstSpawn(
  deps: SpawnLoadoutDeps,
  task: Task,
  env: NodeJS.ProcessEnv,
): Promise<LoadoutResolution | null> {
  if ((task.sessions?.length ?? 0) > 0) return null; // has run before: never resolve fresh (R4)
  if (!deps.loadoutStore || task.agentType !== 'claude-code') return null;
  if (!loadoutActivation(env).firstSpawnResolves) return null;
  let resolution: LoadoutResolution;
  try {
    resolution = await deps.loadoutStore.resolveForLaunch(
      { projectId: task.projectId, playbookId: task.playbookId, taskType: task.agentType },
      { mode: 'bypass' },
    );
  } catch (err) {
    console.warn(
      `[loadout] resolution failed for task ${task.id}; proceeding with no loadout: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  return Object.keys(resolution.loadout.enabledOverrides).length === 0 ? null : resolution;
}

async function recordFirstSpawn(
  deps: SpawnLoadoutDeps,
  task: Task,
  resolution: LoadoutResolution,
  gate: SpawnGateContext,
): Promise<LoadoutLaunchOptionFields> {
  const part = partitionByInstalled(resolution, await readInstalledSafe(deps), await dirNamesSafe(deps));
  for (const s of part.skipped) {
    console.warn(`[loadout] task ${task.id}: ${s.id} is named but not given to the agent (${s.reason})`);
  }
  const record: TaskLoadoutRecord = {
    resolved: part.loadout,
    winningLevel: part.provenance.winningLevel,
    mode: part.provenance.mode,
    settingsHash: null,
    settingsPath: null,
    recordedAt: nowISO(),
    plugins: part.plugins,
    skipped: part.skipped,
    ...(gate.degraded ? { spawnGateDegraded: true as const } : {}),
  };
  deps.taskStore.setLoadout(task.id, record);
  return {
    resolvedLoadout: part.loadout,
    onLoadoutApplied: ({ settingsHash, settingsPath }) => {
      try {
        deps.taskStore.setLoadout(task.id, { ...record, settingsHash, settingsPath });
      } catch (err) {
        console.warn(
          `[loadout] failed to stamp settings hash for task ${task.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

export const LOADOUT_STORE_FILENAME = 'plugin-loadouts.json';
export const LOADOUT_STORE_VERSION = 1;
/** The fleet set's own file (RFC section 1, "Storage"): invisible to an older server, so a rollback never erases it. */
export const PLUGIN_FLEET_FILENAME = 'plugin-fleet.json';

/** On-disk shape. `levels[level][key]` is the desired state attached at that scope. */
export interface LoadoutStoreData {
  version: number;
  levels: Record<ScopedLoadoutLevel, Record<string, LoadoutDesiredState>>;
}

/** The scope keys a launch context supplies for resolution. */
export interface LoadoutLaunchContext {
  projectId?: string;
  playbookId?: string;
  /** Finest scope. Currently optional — the launcher populates it when known. */
  taskType?: string;
}

/** Result of reading the fleet file: the set, and whether the file was present but unreadable. */
export interface FleetFileRead {
  plugins: Record<string, boolean>;
  /** `missing` (no file — an empty set), `ok`, or `malformed` (present but not a valid fleet file; read as empty). */
  status: 'missing' | 'ok' | 'malformed';
}

function emptyStoreData(): LoadoutStoreData {
  return { version: LOADOUT_STORE_VERSION, levels: { 'task-type': {}, playbook: {}, project: {} } };
}

function cleanPluginMap(plugins: unknown): Record<string, boolean> | null {
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return null;
  const clean: Record<string, boolean> = {};
  for (const [id, v] of Object.entries(plugins as Record<string, unknown>)) {
    if (typeof v === 'boolean') clean[id] = v;
  }
  return clean;
}

function coerceStoreData(parsed: unknown): LoadoutStoreData {
  if (typeof parsed !== 'object' || parsed === null) return emptyStoreData();
  const obj = parsed as Partial<LoadoutStoreData>;
  const levelsIn = (obj.levels ?? {}) as Partial<Record<ScopedLoadoutLevel, unknown>>;
  const out = emptyStoreData();
  for (const level of SCOPED_LOADOUT_LEVELS) {
    const map = levelsIn[level];
    if (typeof map !== 'object' || map === null) continue;
    for (const [key, state] of Object.entries(map as Record<string, unknown>)) {
      const clean = cleanPluginMap((state as { plugins?: unknown })?.plugins);
      if (clean) out.levels[level][key] = { plugins: clean };
    }
  }
  return out;
}

export class LoadoutStore {
  private readonly path: string;
  private readonly fleetPath: string;

  constructor(
    dataDir: string,
    filename: string = LOADOUT_STORE_FILENAME,
    fleetFilename: string = PLUGIN_FLEET_FILENAME,
  ) {
    this.path = join(dataDir, filename);
    this.fleetPath = join(dataDir, fleetFilename);
  }

  get filePath(): string {
    return this.path;
  }

  get fleetFilePath(): string {
    return this.fleetPath;
  }

  /** Read the whole store. Malformed-tolerant: missing/unparseable → empty. */
  async read(): Promise<LoadoutStoreData> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return emptyStoreData();
    }
    try {
      return coerceStoreData(JSON.parse(raw));
    } catch {
      return emptyStoreData();
    }
  }

  /**
   * Read the fleet set. Never throws: a missing file is an empty set, and a
   * malformed one reads as empty with `status: 'malformed'` so diagnostics can
   * say so (a broken fleet file must not block a spawn).
   */
  async readFleet(): Promise<FleetFileRead> {
    let raw: string;
    try {
      raw = await readFile(this.fleetPath, 'utf8');
    } catch {
      return { plugins: {}, status: 'missing' };
    }
    try {
      const parsed = JSON.parse(raw) as { plugins?: unknown } | null;
      const clean = cleanPluginMap(parsed?.plugins);
      return clean ? { plugins: clean, status: 'ok' } : { plugins: {}, status: 'malformed' };
    } catch {
      return { plugins: {}, status: 'malformed' };
    }
  }

  /**
   * Replace the fleet set. Logs the before and after sets (RFC section 1, "What
   * a change reaches"). Non-boolean values are dropped. Returns both sets.
   */
  async writeFleet(plugins: Record<string, boolean>): Promise<{ before: Record<string, boolean>; after: Record<string, boolean> }> {
    const before = (await this.readFleet()).plugins;
    const after = cleanPluginMap(plugins) ?? {};
    const sorted = Object.fromEntries(Object.entries(after).sort(([a], [b]) => a.localeCompare(b)));
    await atomicWriteFile(this.fleetPath, `${JSON.stringify({ version: 1, plugins: sorted }, null, 2)}\n`);
    console.log(`[loadout] fleet set changed: before=${JSON.stringify(before)} after=${JSON.stringify(sorted)}`);
    return { before, after: sorted };
  }

  /** Overwrite the desired state at one scope key (authoring route). Empty `plugins` removes the entry. */
  async setLevelState(level: ScopedLoadoutLevel, key: string, state: LoadoutDesiredState): Promise<LoadoutStoreData> {
    const data = await this.read();
    const clean = cleanPluginMap(state.plugins) ?? {};
    if (Object.keys(clean).length === 0) {
      delete data.levels[level][key];
    } else {
      data.levels[level][key] = { plugins: clean };
    }
    await atomicWriteFile(this.path, `${JSON.stringify(data, null, 2)}\n`);
    return data;
  }

  /**
   * Resolve a typed loadout for a launch context. Reads the three keyed level
   * maps and the fleet set, selects the entries whose keys match the context,
   * and delegates to the pure {@link resolveLoadout}. A context with no
   * matching entries and an empty fleet set resolves to an empty loadout
   * (`winningLevel: 'none'`).
   */
  async resolveForLaunch(
    ctx: LoadoutLaunchContext,
    opts: { mode: LoadoutSpawnMode },
  ): Promise<LoadoutResolution> {
    const [data, fleet] = await Promise.all([this.read(), this.readFleet()]);
    return resolveLoadout(
      {
        'task-type': ctx.taskType ? data.levels['task-type'][ctx.taskType] : undefined,
        playbook: ctx.playbookId ? data.levels.playbook[ctx.playbookId] : undefined,
        project: ctx.projectId ? data.levels.project[ctx.projectId] : undefined,
        fleet: { plugins: fleet.plugins },
      },
      opts,
    );
  }
}
