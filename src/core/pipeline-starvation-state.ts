/**
 * Durable per-repo ledger for pipeline-starvation refill (issue #1715).
 *
 * Path: `~/.kookr/playbook-state/pipeline-starvation/<repo-slug>.json`
 * (user-scoped, same tree as other playbook-state artifacts).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  defaultPipelineStarvationStateDir,
  emptyPipelineStarvationState,
  PIPELINE_STARVATION_STATE_SCHEMA,
  pipelineStarvationStatePath,
  type PipelineStarvationRepoState,
} from './pipeline-starvation.js';

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
