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
import { join } from 'node:path';
import { atomicWriteFile } from '../../core/persistence-utils.js';
import { nowISO } from '../../core/interaction-log.js';
import {
  resolveLoadout,
  pluginLoadoutsEnabled,
} from '../../core/claude-settings/loadout.js';
import {
  isEmptyResolvedLoadout,
  type LoadoutDesiredState,
  type LoadoutLevel,
  type LoadoutSpawnMode,
  type ResolvedLoadout,
  type ResolvedLoadoutProvenance,
  type TaskLoadoutRecord,
} from '../../shared/contracts/plugins.js';
import { LOADOUT_LEVELS_MOST_SPECIFIC_FIRST } from '../../shared/contracts/plugins.js';
import type { Task } from '../../core/task-read-model.js';
import type { TaskStore } from '../../core/tasks.js';

/** The adapter-launch-option fields a loadout contributes. Merged into opts at every launch site. */
export interface LoadoutLaunchOptionFields {
  resolvedLoadout?: ResolvedLoadout;
  onLoadoutApplied?: (applied: { settingsHash: string; settingsPath: string }) => void;
}

/**
 * Replay a loadout already recorded on a task, for resume/relaunch launch sites
 * (RFC Layer 2 / slice 2b). A resumed agent MUST get the loadout recorded at
 * its original spawn, never a re-resolved one, or resuming would silently
 * change its capabilities. Returns the exact recorded `ResolvedLoadout`, or no
 * field when the task carries none (then settings stay byte-identical). Needs
 * only the task record — no store — so every resume site can call it cheaply.
 * Lives here (not in launch-service) so the resume sites can import it without
 * a module cycle.
 */
export function replayRecordedLoadout(task: Task): LoadoutLaunchOptionFields {
  return task.loadout ? { resolvedLoadout: task.loadout.resolved } : {};
}

/** Deps for {@link resolveOrReplayLoadout}: the store to resolve from and the task store to record on. */
export interface ResolveOrReplayDeps {
  loadoutStore?: LoadoutStore;
  taskStore: Pick<TaskStore, 'setLoadout'>;
}

/**
 * Derive the loadout for a FIRST spawn (RFC Layer 2 / slice 2b): a direct launch
 * OR a promotion of an admission-parked task (which never reached the direct
 * launch's resolution, so its first `adapter.launch` is at promotion time).
 *
 * - If the task already carries a recorded loadout, REPLAY it verbatim (a
 *   re-promotion or a direct relaunch of a task that already spawned).
 * - Otherwise, when the feature flag is on, a store is configured, and the agent
 *   is claude-code, resolve the Kookr-owned desired state for this task's scope
 *   (bypass mode — the only lever that reaches Kookr's bypass-mode agents),
 *   record the intent on the task, and return an `onLoadoutApplied` callback that
 *   stamps the written settings-file hash + path.
 * - When the feature is off, nothing is attached, resolution errors, or the agent
 *   is not claude-code, return `{}` and the written settings stay byte-identical.
 *
 * Crash-recovery and Ralph relaunch use {@link replayRecordedLoadout} instead
 * (replay-only): those tasks DID spawn and record, so re-resolving them could
 * change a resumed agent's capabilities.
 *
 * The three scope keys map to the Kookr identifiers the launcher has: project →
 * `projectId`, playbook → `playbookId`, task-type → `agentType` (the finest
 * always-present axis — e.g. "all codex tasks").
 */
export async function resolveOrReplayLoadout(
  deps: ResolveOrReplayDeps,
  task: Task,
): Promise<LoadoutLaunchOptionFields> {
  if (task.loadout) return { resolvedLoadout: task.loadout.resolved };
  if (!deps.loadoutStore || !pluginLoadoutsEnabled() || task.agentType !== 'claude-code') {
    return {};
  }
  let resolved: Awaited<ReturnType<LoadoutStore['resolveForLaunch']>>;
  try {
    resolved = await deps.loadoutStore.resolveForLaunch(
      { projectId: task.projectId, playbookId: task.playbookId, taskType: task.agentType },
      { mode: 'bypass' },
    );
  } catch (err) {
    console.warn(
      `[loadout] resolution failed for task ${task.id}; proceeding with no loadout: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  if (isEmptyResolvedLoadout(resolved.loadout)) return {};

  const record: TaskLoadoutRecord = {
    resolved: resolved.loadout,
    winningLevel: resolved.provenance.winningLevel,
    mode: resolved.provenance.mode,
    settingsHash: null,
    settingsPath: null,
    recordedAt: nowISO(),
  };
  deps.taskStore.setLoadout(task.id, record);
  return {
    resolvedLoadout: resolved.loadout,
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

/** On-disk shape. `levels[level][key]` is the desired state attached at that scope. */
export interface LoadoutStoreData {
  version: number;
  levels: Record<LoadoutLevel, Record<string, LoadoutDesiredState>>;
}

/** The scope keys a launch context supplies for resolution. */
export interface LoadoutLaunchContext {
  projectId?: string;
  playbookId?: string;
  /** Finest scope. Currently optional — the launcher populates it when known. */
  taskType?: string;
}

function emptyStoreData(): LoadoutStoreData {
  return { version: LOADOUT_STORE_VERSION, levels: { 'task-type': {}, playbook: {}, project: {} } };
}

function coerceStoreData(parsed: unknown): LoadoutStoreData {
  if (typeof parsed !== 'object' || parsed === null) return emptyStoreData();
  const obj = parsed as Partial<LoadoutStoreData>;
  const levelsIn = (obj.levels ?? {}) as Partial<Record<LoadoutLevel, unknown>>;
  const out = emptyStoreData();
  for (const level of LOADOUT_LEVELS_MOST_SPECIFIC_FIRST) {
    const map = levelsIn[level];
    if (typeof map !== 'object' || map === null) continue;
    for (const [key, state] of Object.entries(map as Record<string, unknown>)) {
      const plugins = (state as { plugins?: unknown })?.plugins;
      if (typeof plugins !== 'object' || plugins === null) continue;
      const clean: Record<string, boolean> = {};
      for (const [id, v] of Object.entries(plugins as Record<string, unknown>)) {
        if (typeof v === 'boolean') clean[id] = v;
      }
      out.levels[level][key] = { plugins: clean };
    }
  }
  return out;
}

export class LoadoutStore {
  private readonly path: string;

  constructor(dataDir: string, filename: string = LOADOUT_STORE_FILENAME) {
    this.path = join(dataDir, filename);
  }

  get filePath(): string {
    return this.path;
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

  /** Overwrite the desired state at one scope key (authoring route). Empty `plugins` removes the entry. */
  async setLevelState(level: LoadoutLevel, key: string, state: LoadoutDesiredState): Promise<LoadoutStoreData> {
    const data = await this.read();
    const clean: Record<string, boolean> = {};
    for (const [id, v] of Object.entries(state.plugins ?? {})) {
      if (typeof v === 'boolean') clean[id] = v;
    }
    if (Object.keys(clean).length === 0) {
      delete data.levels[level][key];
    } else {
      data.levels[level][key] = { plugins: clean };
    }
    await atomicWriteFile(this.path, `${JSON.stringify(data, null, 2)}\n`);
    return data;
  }

  /**
   * Resolve a typed loadout for a launch context. Reads the three level maps,
   * selects the entries whose keys match the context, and delegates to the pure
   * {@link resolveLoadout}. A context with no matching entries resolves to an
   * empty loadout (`winningLevel: 'none'`).
   */
  async resolveForLaunch(
    ctx: LoadoutLaunchContext,
    opts: { mode: LoadoutSpawnMode },
  ): Promise<{ loadout: ResolvedLoadout; provenance: ResolvedLoadoutProvenance }> {
    const data = await this.read();
    return resolveLoadout(
      {
        'task-type': ctx.taskType ? data.levels['task-type'][ctx.taskType] : undefined,
        playbook: ctx.playbookId ? data.levels.playbook[ctx.playbookId] : undefined,
        project: ctx.projectId ? data.levels.project[ctx.projectId] : undefined,
      },
      opts,
    );
  }
}
