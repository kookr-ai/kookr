/**
 * Config epoch + reload-drift surface (RFC "Surfacing reload drift").
 *
 * A **config epoch** is a monotonically increasing counter bumped on ANY Kookr
 * plugin/settings change (own-session install / add-marketplace / enable-disable
 * / update). Each Kookr-managed Claude session is stamped at its first spawn with
 * the epoch it started under ({@link stampSessionConfigEpoch}); the dashboard then
 * surfaces the sessions that started before the latest change, with a restart
 * action ({@link computeConfigDrift}).
 *
 * The store lives beside the other plugin-manager seams but is deliberately
 * separate from the mutation/loadout modules (RFC F2: a parsing or resolution bug
 * must not share a module with durable state). The drift computation is a PURE
 * function over a minimal session view, so it is testable without a TaskStore.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../core/persistence-utils.js';
import type { ConfigDriftSurface, DriftedSession } from '../../shared/contracts/plugins.js';
import { EXTERNAL_TUI_COVERAGE_NOTE } from '../../shared/contracts/plugins.js';
import type { Task } from '../../core/task-read-model.js';
import type { TaskStore } from '../../core/tasks.js';

export const CONFIG_EPOCH_FILENAME = 'plugin-config-epoch.json';
export const CONFIG_EPOCH_VERSION = 1;

/** On-disk shape of the epoch counter. */
export interface ConfigEpochData {
  version: number;
  epoch: number;
  /** ISO-8601 time of the most recent bump, or null before the first bump. */
  bumpedAt: string | null;
}

function emptyEpochData(): ConfigEpochData {
  return { version: CONFIG_EPOCH_VERSION, epoch: 0, bumpedAt: null };
}

/** A valid epoch is a finite, non-negative integer; anything else reads as 0. */
function coerceEpoch(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Single Kookr-owned persistence for the plugin/settings config epoch: one
 * versioned JSON file under the Kookr data dir. Reads are malformed-tolerant: a
 * missing or unparseable file resolves to epoch 0, never throws (a drift read
 * must not be blockable by a corrupt counter file).
 */
export class ConfigEpochStore {
  private readonly path: string;

  constructor(dataDir: string, filename: string = CONFIG_EPOCH_FILENAME) {
    this.path = join(dataDir, filename);
  }

  get filePath(): string {
    return this.path;
  }

  /** Read the counter (malformed/missing → epoch 0). */
  async read(): Promise<ConfigEpochData> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return emptyEpochData();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ConfigEpochData>;
      return {
        version: CONFIG_EPOCH_VERSION,
        epoch: coerceEpoch(parsed?.epoch),
        bumpedAt: typeof parsed?.bumpedAt === 'string' ? parsed.bumpedAt : null,
      };
    } catch {
      return emptyEpochData();
    }
  }

  /** The current epoch (what a new session is stamped with). */
  async current(): Promise<number> {
    return (await this.read()).epoch;
  }

  /**
   * Increment the epoch and persist it atomically. Returns the NEW epoch.
   * Callers bump AFTER a successful mutation so a failed/rolled-back change does
   * not advance the counter (which would make unaffected sessions look stale).
   */
  async bump(now: () => Date = () => new Date()): Promise<number> {
    const data = await this.read();
    const next: ConfigEpochData = {
      version: CONFIG_EPOCH_VERSION,
      epoch: data.epoch + 1,
      bumpedAt: now().toISOString(),
    };
    await atomicWriteFile(this.path, `${JSON.stringify(next, null, 2)}\n`);
    return next.epoch;
  }
}

/** The minimal per-session view {@link computeConfigDrift} needs (decoupled from Task). */
export interface SessionEpochView {
  taskId: string;
  /** Only `claude-code` sessions read plugin/settings config; others are ignored. */
  agentType: string;
  /** A terminal session needs no restart. */
  isTerminal: boolean;
  /** The epoch stamped at first spawn; `undefined` for legacy/unstamped sessions. */
  configEpochAtStart: number | undefined;
  /** ISO-8601 start time, for newest-first ordering. */
  startedAt: string;
  title?: string;
}

/**
 * Compute the reload-drift surface (PURE). A session is "stale" — started before
 * the latest config change — when it is a non-terminal **Kookr-managed Claude**
 * session (`agentType === 'claude-code'`) whose stamped start epoch is strictly
 * behind `currentEpoch`. Sessions with an UNKNOWN start epoch are excluded (we
 * cannot assert they are behind, so we never nag about them). The external-TUI
 * note is always present: Kookr states its blind spot rather than implying it
 * covers the operator's sessions in other terminals.
 */
export function computeConfigDrift(
  currentEpoch: number,
  sessions: readonly SessionEpochView[],
): ConfigDriftSurface {
  const stale: DriftedSession[] = [];
  for (const s of sessions) {
    if (s.agentType !== 'claude-code') continue;
    if (s.isTerminal) continue;
    if (typeof s.configEpochAtStart !== 'number') continue;
    if (s.configEpochAtStart >= currentEpoch) continue;
    stale.push({
      taskId: s.taskId,
      startedEpoch: s.configEpochAtStart,
      startedAt: s.startedAt,
      ...(s.title ? { title: s.title } : {}),
    });
  }
  stale.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    currentEpoch,
    staleSessions: stale,
    staleCount: stale.length,
    externalCoverageNote: EXTERNAL_TUI_COVERAGE_NOTE,
  };
}

/** Deps for {@link stampSessionConfigEpoch}: the epoch source + the task-store setter. */
export interface StampConfigEpochDeps {
  configEpochStore?: ConfigEpochStore;
  taskStore: Pick<TaskStore, 'setConfigEpochAtStart'>;
}

/**
 * Stamp a Kookr-managed Claude session with the config epoch it started under,
 * at its FIRST spawn only. Mirrors the loadout stamping guard: a no-op when the
 * feature is unwired (no store), the agent is not claude-code, or the task was
 * already stamped (so resume/relaunch keep the ORIGINAL start epoch — a resumed
 * session did not start fresh under the current config). Never throws; a stamp
 * failure is logged and the spawn proceeds.
 */
export async function stampSessionConfigEpoch(
  deps: StampConfigEpochDeps,
  task: Pick<Task, 'id' | 'agentType' | 'configEpochAtStart'>,
): Promise<void> {
  if (!deps.configEpochStore) return;
  if (task.agentType !== 'claude-code') return;
  if (typeof task.configEpochAtStart === 'number') return;
  try {
    const epoch = await deps.configEpochStore.current();
    deps.taskStore.setConfigEpochAtStart(task.id, epoch);
  } catch (err) {
    console.warn(
      `[config-epoch] failed to stamp task ${task.id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
