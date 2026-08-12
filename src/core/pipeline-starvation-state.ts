/**
 * Durable per-repo ledger for pipeline-starvation refill (issue #1715).
 *
 * Path: `~/.kookr/playbook-state/pipeline-starvation/<repo-slug>.json`
 * (user-scoped, same tree as other playbook-state artifacts).
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  defaultPipelineStarvationStateDir,
  effectiveStarvationScoutCooldownMs,
  emptyPipelineStarvationState,
  PIPELINE_STARVATION_STATE_SCHEMA,
  pipelineStarvationStatePath,
  type PipelineStarvationRepoState,
} from './pipeline-starvation.js';
import {
  accumulateInventPriorityCount,
  emptyInventPriorityCounts,
  type InventPriorityClass,
} from './starvation-invent-policy.js';
import { queueFeederLedgerPath } from './umbrella-decomposer.js';

/** Compact health/projection row for one repo (RFC overnight-throughput PR1/PR4). */
export interface PipelineStarvationHealthRepo {
  repo: string;
  consecutiveBlockedEmpty: number;
  lastBlockedEmptyAt: string | null;
  lastSpawnSkipReason: string | null;
  lastSpawnSkipAt: string | null;
  lastStarvationScoutTaskId: string | null;
  lastStarvationScoutAt: string | null;
  lastStarvationAlertAt: string | null;
  lastBatchKickAt: string | null;
  kickBatchWhenScoutCompletes: boolean;
  /**
   * Times cooldown/anti-thrash blocked a scout while capacity was belt-empty
   * (issue #2068). 0 when never observed.
   */
  scoutCooldownSkipsWhileBeltEmpty: number;
  /**
   * Effective adaptive scout cooldown (ms) at the current
   * `consecutiveBlockedEmpty` depth (issue #2171). Lets an operator read the
   * cooldown shrinking as the drought deepens without recomputing it.
   */
  effectiveScoutCooldownMs: number;
  updatedAt: string;
}

/** Rolling invent-class mix for the starvation card (issue #2358). */
export interface InventPriorityClassHealth {
  product: number;
  micro: number;
  other: number;
  /** Lookback window used for the rollup (hours). */
  windowHours: number;
}

/** Default lookback for invent-class health rollup from the queue-feeder ledger. */
export const INVENT_PRIORITY_HEALTH_WINDOW_HOURS = 24;

/**
 * Roll invent-class counts from the queue-feeder decisions ledger (issue #2358).
 * Soft-fails missing/corrupt files; only counts invent/shred/secondary emits
 * that carry inventPriorityClass (or infers product for invent-product-wave).
 */
export async function loadInventPriorityClassHealth(
  opts: {
    kookrDir?: string;
    nowMs?: number;
    windowHours?: number;
  } = {},
): Promise<InventPriorityClassHealth> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = opts.windowHours ?? INVENT_PRIORITY_HEALTH_WINDOW_HOURS;
  const windowMs = Math.max(1, windowHours) * 3_600_000;
  const cutoff = nowMs - windowMs;
  const counts = emptyInventPriorityCounts();
  const kookrDir = opts.kookrDir ?? join(
    process.env.HOME ?? process.env.USERPROFILE ?? '',
    '.kookr',
  );
  const path = queueFeederLedgerPath(kookrDir);
  try {
    const raw = await readFile(path, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const action = typeof row.action === 'string' ? row.action : '';
      if (
        action !== 'shred'
        && action !== 'invent-product-wave'
        && action !== 'emit-secondary'
      ) {
        continue;
      }
      let klass: InventPriorityClass | null = null;
      if (
        row.inventPriorityClass === 'product'
        || row.inventPriorityClass === 'micro'
        || row.inventPriorityClass === 'other'
      ) {
        klass = row.inventPriorityClass;
      } else if (action === 'invent-product-wave') {
        klass = 'product';
      } else if (action === 'shred' && row.productMetricBlocking === true) {
        klass = 'product';
      } else if (action === 'emit-secondary') {
        klass = 'other';
      }
      if (!klass) continue;
      const n =
        typeof row.leafCount === 'number' && Number.isFinite(row.leafCount) && row.leafCount > 0
          ? Math.floor(row.leafCount)
          : 1;
      Object.assign(counts, accumulateInventPriorityCount(counts, klass, n));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Soft-fail corrupt/missing ledger — health still returns zeros.
    }
  }
  return {
    product: counts.product,
    micro: counts.micro,
    other: counts.other,
    windowHours,
  };
}

/**
 * Load all durable pipeline-starvation state files for health projection.
 * Soft-fails empty/missing dirs; skips unreadable rows.
 */
export async function listPipelineStarvationHealth(
  opts: { stateDir?: string; nowMs?: number } = {},
): Promise<Record<string, PipelineStarvationHealthRepo>> {
  const stateDir = opts.stateDir ?? defaultPipelineStarvationStateDir();
  const nowMs = opts.nowMs ?? Date.now();
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  const out: Record<string, PipelineStarvationHealthRepo> = {};
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const raw = await readFile(join(stateDir, name), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PipelineStarvationRepoState>;
      if (parsed.schemaVersion !== PIPELINE_STARVATION_STATE_SCHEMA || typeof parsed.repo !== 'string') {
        continue;
      }
      const blocked = Array.isArray(parsed.blockedEmptyAt)
        ? parsed.blockedEmptyAt.filter((x): x is string => typeof x === 'string')
        : [];
      out[parsed.repo] = {
        repo: parsed.repo,
        consecutiveBlockedEmpty: blocked.length,
        effectiveScoutCooldownMs: effectiveStarvationScoutCooldownMs(blocked.length),
        lastBlockedEmptyAt: blocked.length > 0 ? blocked[blocked.length - 1]! : null,
        lastSpawnSkipReason: typeof parsed.lastSpawnSkipReason === 'string'
          ? parsed.lastSpawnSkipReason
          : null,
        lastSpawnSkipAt: typeof parsed.lastSpawnSkipAt === 'string' ? parsed.lastSpawnSkipAt : null,
        lastStarvationScoutTaskId: typeof parsed.lastStarvationScoutTaskId === 'string'
          ? parsed.lastStarvationScoutTaskId
          : null,
        lastStarvationScoutAt: typeof parsed.lastStarvationScoutAt === 'string'
          ? parsed.lastStarvationScoutAt
          : null,
        lastStarvationAlertAt: typeof parsed.lastStarvationAlertAt === 'string'
          ? parsed.lastStarvationAlertAt
          : null,
        lastBatchKickAt: typeof parsed.lastBatchKickAt === 'string'
          ? parsed.lastBatchKickAt
          : null,
        kickBatchWhenScoutCompletes: parsed.kickBatchWhenScoutCompletes === true,
        scoutCooldownSkipsWhileBeltEmpty:
          typeof parsed.scoutCooldownSkipsWhileBeltEmpty === 'number'
          && Number.isFinite(parsed.scoutCooldownSkipsWhileBeltEmpty)
          && parsed.scoutCooldownSkipsWhileBeltEmpty > 0
            ? Math.floor(parsed.scoutCooldownSkipsWhileBeltEmpty)
            : 0,
        updatedAt: typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date(nowMs).toISOString(),
      };
    } catch {
      // skip corrupt row
    }
  }
  return out;
}

export async function loadPipelineStarvationState(
  repo: string,
  opts: { stateDir?: string; nowMs?: number } = {},
): Promise<PipelineStarvationRepoState> {
  const stateDir = opts.stateDir ?? defaultPipelineStarvationStateDir();
  const path = pipelineStarvationStatePath(stateDir, repo);
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PipelineStarvationRepoState>;
    if (parsed.schemaVersion !== PIPELINE_STARVATION_STATE_SCHEMA || typeof parsed.repo !== 'string') {
      return emptyPipelineStarvationState(repo, nowMs);
    }
    return {
      schemaVersion: PIPELINE_STARVATION_STATE_SCHEMA,
      repo: parsed.repo,
      blockedEmptyAt: Array.isArray(parsed.blockedEmptyAt)
        ? parsed.blockedEmptyAt.filter((x): x is string => typeof x === 'string')
        : [],
      handledRunKeys: Array.isArray(parsed.handledRunKeys)
        ? parsed.handledRunKeys.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [],
      lastStarvationScoutAt: typeof parsed.lastStarvationScoutAt === 'string'
        ? parsed.lastStarvationScoutAt
        : undefined,
      lastStarvationScoutTaskId: typeof parsed.lastStarvationScoutTaskId === 'string'
        ? parsed.lastStarvationScoutTaskId
        : undefined,
      lastStarvationAlertAt: typeof parsed.lastStarvationAlertAt === 'string'
        ? parsed.lastStarvationAlertAt
        : undefined,
      lastSpawnSkipReason: typeof parsed.lastSpawnSkipReason === 'string'
        ? parsed.lastSpawnSkipReason
        : undefined,
      lastSpawnSkipAt: typeof parsed.lastSpawnSkipAt === 'string'
        ? parsed.lastSpawnSkipAt
        : undefined,
      lastBatchKickAt: typeof parsed.lastBatchKickAt === 'string'
        ? parsed.lastBatchKickAt
        : undefined,
      kickBatchWhenScoutCompletes: parsed.kickBatchWhenScoutCompletes === true
        ? true
        : undefined,
      kickBatchWhenScoutCompletesAt: typeof parsed.kickBatchWhenScoutCompletesAt === 'string'
        ? parsed.kickBatchWhenScoutCompletesAt
        : undefined,
      scoutCooldownSkipsWhileBeltEmpty:
        typeof parsed.scoutCooldownSkipsWhileBeltEmpty === 'number'
        && Number.isFinite(parsed.scoutCooldownSkipsWhileBeltEmpty)
        && parsed.scoutCooldownSkipsWhileBeltEmpty > 0
          ? Math.floor(parsed.scoutCooldownSkipsWhileBeltEmpty)
          : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(nowMs).toISOString(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyPipelineStarvationState(repo, nowMs);
    }
    throw err;
  }
}

export async function savePipelineStarvationState(
  state: PipelineStarvationRepoState,
  opts: { stateDir?: string } = {},
): Promise<string> {
  const stateDir = opts.stateDir ?? defaultPipelineStarvationStateDir();
  const path = pipelineStarvationStatePath(stateDir, state.repo);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  await rename(tmp, path);
  return path;
}
