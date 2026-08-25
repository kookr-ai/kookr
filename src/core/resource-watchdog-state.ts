/**
 * Durable resource-watchdog state (issue #1724).
 *
 * Persists the 30-min throttle timestamp and the rolling 24h spawn budget in
 * `~/.kookr/resource-watchdog.state.json` so a server restart cannot re-arm a
 * just-fired watchdog and flood the host with investigation tasks.
 *
 * Read/write helpers are injectable for unit tests (no real disk required).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  RESOURCE_WATCHDOG_STATE_SCHEMA_VERSION,
  type ResourceWatchdogPersistedState,
  type ResourceWatchdogSpawnKind,
  type ResourceWatchdogTriggerReason,
} from './resource-watchdog-types.js';
import { pruneSpawnTimestamps } from './resource-watchdog-eval.js';

export function emptyResourceWatchdogState(): ResourceWatchdogPersistedState {
  return {
    schemaVersion: RESOURCE_WATCHDOG_STATE_SCHEMA_VERSION,
    spawnTimestamps: [],
    lastSpawnAt: null,
    lastSpawnKind: null,
    lastSpawnTaskId: null,
    lastTriggerAt: null,
    lastTriggerReasons: [],
    lastMetaReflectionAt: null,
  };
}

export function isResourceWatchdogPersistedState(
  value: unknown,
): value is ResourceWatchdogPersistedState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== RESOURCE_WATCHDOG_STATE_SCHEMA_VERSION) return false;
  if (!Array.isArray(v.spawnTimestamps)) return false;
  if (!v.spawnTimestamps.every((t) => typeof t === 'string')) return false;
  if (v.lastSpawnAt !== null && typeof v.lastSpawnAt !== 'string') return false;
  if (v.lastSpawnKind !== null
    && v.lastSpawnKind !== 'investigation'
    && v.lastSpawnKind !== 'meta_reflection') {
    return false;
  }
  if (v.lastSpawnTaskId !== null && typeof v.lastSpawnTaskId !== 'string') return false;
  if (v.lastTriggerAt !== null && typeof v.lastTriggerAt !== 'string') return false;
  if (!Array.isArray(v.lastTriggerReasons)) return false;
  if (v.lastMetaReflectionAt !== null && typeof v.lastMetaReflectionAt !== 'string') return false;
  return true;
}

export interface ResourceWatchdogStateStore {
  load(): ResourceWatchdogPersistedState;
  save(state: ResourceWatchdogPersistedState): void;
}

/**
 * File-backed store. Corrupt/missing files return empty state (fail-open so a
 * bad write cannot disable the whole actuator permanently).
 */
export class FileResourceWatchdogStateStore implements ResourceWatchdogStateStore {
  constructor(private readonly path: string) {}

  load(): ResourceWatchdogPersistedState {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isResourceWatchdogPersistedState(parsed)) return parsed;
      return emptyResourceWatchdogState();
    } catch {
      return emptyResourceWatchdogState();
    }
  }

  save(state: ResourceWatchdogPersistedState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Atomic write (temp + rename) so a crash mid-write cannot leave a
    // truncated JSON that fail-open-loads as empty and re-arms the throttle.
    const tempPath = join(
      dirname(this.path),
      `.resource-watchdog-state.${randomBytes(6).toString('hex')}.tmp`,
    );
    let renamed = false;
    try {
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
      renameSync(tempPath, this.path);
      renamed = true;
    } finally {
      if (!renamed) {
        try { unlinkSync(tempPath); } catch { /* best-effort */ }
      }
    }
  }
}

export interface RecordSpawnInput {
  state: ResourceWatchdogPersistedState;
  nowIso: string;
  nowMs: number;
  kind: ResourceWatchdogSpawnKind;
  taskId: string | null;
  triggerReasons: ResourceWatchdogTriggerReason[];
  /** Retain timestamps at least this long (max of throttle + budget windows). */
  retainMs: number;
}

/** Return a new state with this spawn recorded (pure). */
export function recordSpawn(input: RecordSpawnInput): ResourceWatchdogPersistedState {
  const pruned = pruneSpawnTimestamps(
    [...input.state.spawnTimestamps, input.nowIso],
    input.nowMs,
    input.retainMs,
  );
  return {
    ...input.state,
    spawnTimestamps: pruned,
    lastSpawnAt: input.nowIso,
    lastSpawnKind: input.kind,
    lastSpawnTaskId: input.taskId,
    lastTriggerAt: input.nowIso,
    lastTriggerReasons: input.triggerReasons,
    lastMetaReflectionAt:
      input.kind === 'meta_reflection' ? input.nowIso : input.state.lastMetaReflectionAt,
  };
}

export interface RecordTriggerOnlyInput {
  state: ResourceWatchdogPersistedState;
  nowIso: string;
  triggerReasons: ResourceWatchdogTriggerReason[];
}

/** Record a trigger that did not produce a spawn (throttled or failed). */
export function recordTriggerOnly(
  input: RecordTriggerOnlyInput,
): ResourceWatchdogPersistedState {
  return {
    ...input.state,
    lastTriggerAt: input.nowIso,
    lastTriggerReasons: input.triggerReasons,
  };
}
