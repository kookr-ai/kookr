/**
 * Discover recent successful idea-scout runs and in-flight scouts for a repo
 * (issue #1715 starvation-refill inputs; RFC overnight-throughput PR1).
 *
 * "Successful ideation" requires ≥1 published issue receipt (`issue-created.json`)
 * under the run — DONE+mtime alone is content-blind and suppressed overnight
 * refill when scouts finished without usable issues.
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

const UMBRELLA_TITLE_RE = /umbrella/i;

export interface SuccessfulIdeationHit {
  /** Completion clock for the run (state.md mtime when present, else dir mtime). */
  atMs: number;
  /** Count of non-umbrella issue-created receipts under the run. */
  issueCreatedCount: number;
  runKey: string;
}

/**
 * Count non-umbrella `issue-created.json` receipts under an idea-scout run dir.
 * Walks recommendations/<slug>/issue-created.json and top-level issue-created.json.
 */
export async function countEligibleIssueCreatedInRunDir(runDir: string): Promise<number> {
  let count = 0;

  const tryFile = async (path: string): Promise<void> => {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as { title?: unknown; number?: unknown };
      const title = typeof parsed.title === 'string' ? parsed.title : '';
      if (UMBRELLA_TITLE_RE.test(title)) return;
      // Require a published issue number when present; accept missing number
      // only if title is non-empty (older receipts).
      if (typeof parsed.number === 'number' || title.length > 0) count += 1;
    } catch {
      // unreadable / invalid JSON — skip
    }
  };

  await tryFile(join(runDir, 'issue-created.json'));

  const recRoot = join(runDir, 'recommendations');
  let recEntries: string[];
  try {
    recEntries = await readdir(recRoot);
  } catch {
    return count;
  }
  for (const name of recEntries) {
    if (name.startsWith('.')) continue;
    await tryFile(join(recRoot, name, 'issue-created.json'));
  }
  return count;
}

/**
 * Scan idea-scout playbook-state for a successful completion inside the
 * lookback window. Success requires ≥1 non-umbrella issue-created receipt.
 * Prefer runs that also have a DONE marker in state.md when present.
 */
export async function findRecentSuccessfulIdeationDetails(
  repo: string,
  opts: {
    nowMs?: number;
    lookbackMs?: number;
    ideaScoutStateDir?: string;
  } = {},
): Promise<SuccessfulIdeationHit | null> {
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

  let best: SuccessfulIdeationHit | null = null;
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
    if (runStat.mtimeMs < windowStart) continue;

    const issueCreatedCount = await countEligibleIssueCreatedInRunDir(runDir);
    if (issueCreatedCount < 1) continue;

    let atMs = runStat.mtimeMs;
    const statePath = join(runDir, 'state.md');
    try {
      const body = await readFile(statePath, 'utf-8');
      // Prefer DONE-marked runs, but do not require DONE if issue-created exists
      // (some runs leave receipts before writing the marker).
      const stateMtime = (await stat(statePath)).mtimeMs;
      if (stateMtime >= windowStart) {
        atMs = stateMtime;
      }
      if (!DONE_MARKERS.some((re) => re.test(body)) && stateMtime < windowStart) {
        // state.md is stale outside window — keep dir mtime
      }
    } catch {
      // No state.md — issue-created alone is enough.
    }

    if (atMs < windowStart) continue;
    if (best === null || atMs > best.atMs) {
      best = { atMs, issueCreatedCount, runKey };
    }
  }
  return best;
}

/**
 * Timestamp (ms) of the most recent successful ideation, or null.
 * Back-compat wrapper for callers that only need the suppress clock.
 */
export async function findRecentSuccessfulIdeationAtMs(
  repo: string,
  opts: {
    nowMs?: number;
    lookbackMs?: number;
    ideaScoutStateDir?: string;
  } = {},
): Promise<number | null> {
  const hit = await findRecentSuccessfulIdeationDetails(repo, opts);
  return hit?.atMs ?? null;
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
