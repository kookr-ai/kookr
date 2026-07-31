/**
 * Discover recent successful idea-scout runs and in-flight scouts for a repo
 * (issue #1715 starvation-refill inputs).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isTerminalStatus } from './task-status.js';
import type { Task } from './tasks.js';
import {
  defaultIdeaScoutRepoStateDir,
  repoToPlaybookSlug,
  SUCCESSFUL_IDEATION_LOOKBACK_MS,
} from './pipeline-starvation.js';
import { projectIdFromRepoSpecifier } from './project-identity.js';

const DONE_MARKERS = [
  /<promise>\s*DONE\s*<\/promise>/i,
  /^DONE\b/m,
  /STOP:\s*COMPLETE/i,
];

/**
 * Scan idea-scout playbook-state for a successful completion inside the
 * lookback window. Uses directory mtime as the completion clock (state.md
 * is rewritten at end of run) and requires a DONE marker in state.md when
 * present.
 */
export async function findRecentSuccessfulIdeationAtMs(
  repo: string,
  opts: {
    nowMs?: number;
    lookbackMs?: number;
    ideaScoutStateDir?: string;
  } = {},
): Promise<number | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const lookbackMs = opts.lookbackMs ?? SUCCESSFUL_IDEATION_LOOKBACK_MS;
  const windowStart = nowMs - lookbackMs;
  const base = opts.ideaScoutStateDir ?? defaultIdeaScoutRepoStateDir(repo);

  let entries: string[];
  try {
    entries = await readdir(base);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let newest: number | null = null;
  for (const runKey of entries) {
    if (runKey.startsWith('.')) continue;
    const runDir = join(base, runKey);
    let runStat;
    try {
      runStat = await stat(runDir);
    } catch {
      continue;
    }
    if (!runStat.isDirectory()) continue;
    const mtimeMs = runStat.mtimeMs;
    if (mtimeMs < windowStart) continue;

    const statePath = join(runDir, 'state.md');
    try {
      const body = await readFile(statePath, 'utf-8');
      if (!DONE_MARKERS.some((re) => re.test(body))) continue;
      const stateMtime = (await stat(statePath)).mtimeMs;
      if (stateMtime < windowStart) continue;
      if (newest === null || stateMtime > newest) newest = stateMtime;
    } catch {
      // No state.md or unreadable — skip.
    }
  }
  return newest;
}

/**
 * True when any non-terminal task looks like a repository-idea-scout for the
 * given repo (by playbookId + projectId, with prompt fallback).
 */
export function isIdeaScoutInFlightForRepo(repo: string, tasks: readonly Task[]): boolean {
  const projectId = projectIdFromRepoSpecifier(repo)?.toLowerCase() ?? null;
  const slug = repoToPlaybookSlug(repo);
  const repoLower = repo.trim().toLowerCase();

  for (const task of tasks) {
    if (isTerminalStatus(task.status)) continue;
    const playbookId = (task.playbookId ?? '').toLowerCase();
    const isScoutPlaybook =
      playbookId.includes('repository-idea-scout')
      || playbookId.endsWith('idea-scout.md')
      || playbookId.includes('idea-scout');
    if (!isScoutPlaybook) {
      // Prompt fallback for CLI-spawned scouts without playbookId stamp.
      const prompt = (task.prompt ?? '').toLowerCase();
      if (!prompt.includes('repository idea scout') && !prompt.includes('idea-scout')) continue;
    }
    if (projectId && task.projectId?.toLowerCase() === projectId) return true;
    // Fall back to repo string in prompt / name when projectId is unset.
    const hay = `${task.projectId ?? ''} ${task.name ?? ''} ${task.prompt ?? ''}`.toLowerCase();
    if (hay.includes(repoLower) || hay.includes(slug)) return true;
  }
  return false;
}
