/**
 * Stateful glue between the pure emitters and the operator-signal outbox
 * (issue #1716). Monitors (or the `kookr-signal-emit` CLI) call these to turn a
 * status reading / registry check into spooled signal files, with the small bit
 * of persisted state each emitter needs (last-known status, last-emitted map)
 * kept as dotfiles alongside the outbox.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { detectTransition, type MonitorStatus } from './emit-transition.js';
import {
  checkLiveness,
  type LivenessRegistryEntry,
  type LivenessState,
} from './liveness.js';
import { writeOperatorSignal } from './operator-signal.js';

export const TRANSITION_STATE_FILE = '.transition-state.json';
export const LIVENESS_STATE_FILE = '.liveness-state.json';

/** map: monitor source → last known status. */
type TransitionState = Record<string, MonitorStatus>;

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    return fallback;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    return fallback;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-write`;
  let renamed = false;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try { await unlink(tmp); } catch { /* best-effort temp cleanup */ }
    }
  }
}

export interface RunTransitionEmitInput {
  dir: string;
  source: string;
  curr: MonitorStatus;
  detail?: string;
  now?: () => Date;
}

export interface RunTransitionEmitResult {
  emitted: boolean;
  fileName?: string;
  prev: MonitorStatus;
  next: MonitorStatus;
}

/**
 * Record the current status for `source`, and when it crosses the ok/alert
 * boundary versus the persisted last-known status, spool the transition signal.
 */
export async function runTransitionEmit(input: RunTransitionEmitInput): Promise<RunTransitionEmitResult> {
  const { dir, source, curr, detail } = input;
  await mkdir(dir, { recursive: true });
  const statePath = join(dir, TRANSITION_STATE_FILE);
  const state = await readJsonFile<TransitionState>(statePath, {});
  const prev = state[source] ?? 'unknown';

  const { signal, nextPrev } = detectTransition({ source, prev, curr, ...(detail !== undefined ? { detail } : {}) });
  state[source] = nextPrev;
  await writeJsonFile(statePath, state);

  if (!signal) return { emitted: false, prev, next: nextPrev };

  const { fileName } = await writeOperatorSignal(
    dir,
    {
      key: signal.key,
      kind: signal.kind,
      source: signal.source,
      title: signal.title,
      ...(signal.detail !== undefined ? { detail: signal.detail } : {}),
    },
    input.now,
  );
  return { emitted: true, fileName, prev, next: nextPrev };
}

export interface RunLivenessEmitInput {
  dir: string;
  registry: readonly LivenessRegistryEntry[];
  ageMsOf: (entry: LivenessRegistryEntry) => number | null;
  now: () => Date;
  reEmitIntervalMs?: number;
}

export interface RunLivenessEmitResult {
  emitted: number;
  fileNames: string[];
}

/**
 * Check the liveness registry and spool one signal per newly-stale (or
 * recovered) artifact, persisting the per-artifact emit state.
 */
export async function runLivenessEmit(input: RunLivenessEmitInput): Promise<RunLivenessEmitResult> {
  const { dir, registry, ageMsOf } = input;
  await mkdir(dir, { recursive: true });
  const statePath = join(dir, LIVENESS_STATE_FILE);
  const prevState = await readJsonFile<LivenessState>(statePath, {});
  const nowMs = input.now().getTime();

  const { signals, nextState } = checkLiveness({
    registry,
    ageMsOf,
    now: nowMs,
    prevState,
    ...(input.reEmitIntervalMs !== undefined ? { reEmitIntervalMs: input.reEmitIntervalMs } : {}),
  });
  await writeJsonFile(statePath, nextState);

  const fileNames: string[] = [];
  for (const signal of signals) {
    const { fileName } = await writeOperatorSignal(
      dir,
      {
        key: signal.key,
        kind: signal.kind,
        source: signal.source,
        title: signal.title,
        ...(signal.detail !== undefined ? { detail: signal.detail } : {}),
      },
      input.now,
    );
    fileNames.push(fileName);
  }
  return { emitted: fileNames.length, fileNames };
}
