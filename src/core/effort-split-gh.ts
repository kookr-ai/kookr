/**
 * gh-backed gatherer for effort-split metrics (issue #1718).
 *
 * Source of truth is `gh` only — never the contribution ledger. Injectable
 * runner for unit tests.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepoEffortMetrics } from './effort-split.js';

const execFileAsync = promisify(execFileCb);

/** Runs `gh <args…>` and returns stdout. Throws on non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

export interface GatherEffortOptions {
  /** Window start (ISO). */
  sinceIso: string;
  /** Window end (ISO). Commits/PRs at or after this are excluded when filterable. */
  untilIso: string;
  /** Override for tests. Default shells out to `gh`. */
  runGh?: GhRunner;
  /** Max PRs to pull per repo (gh --limit). */
  prLimit?: number;
}

export const DEFAULT_EFFORT_REPOS = ['jeanibarz/lucy', 'kookr-ai/kookr'] as const;

interface GhMergedPr {
  number?: number;
  additions?: number;
  deletions?: number;
  mergedAt?: string;
}

interface GhCommit {
  sha?: string;
  parents?: Array<{ sha?: string }>;
  commit?: { committer?: { date?: string }; author?: { date?: string } };
}

export function defaultGhRunner(): GhRunner {
  return async (args: string[]) => {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  };
}

/**
 * Gather non-merge commits, merged PRs, and lines changed for one repo via gh.
 */
export async function gatherRepoEffortMetrics(
  repo: string,
  options: GatherEffortOptions,
): Promise<RepoEffortMetrics> {
  const runGh = options.runGh ?? defaultGhRunner();
  const prLimit = options.prLimit ?? 200;
  const sinceDay = options.sinceIso.slice(0, 10);
  const untilMs = Date.parse(options.untilIso);
  const sinceMs = Date.parse(options.sinceIso);

  const [prs, commits] = await Promise.all([
    listMergedPrs(runGh, repo, sinceDay, prLimit),
    listCommits(runGh, repo, options.sinceIso, options.untilIso),
  ]);

  // Keep PRs whose mergedAt falls inside [since, until). Search is day-granular
  // so we re-filter client-side when timestamps are available.
  let additions = 0;
  let deletions = 0;
  let prsMerged = 0;
  for (const pr of prs) {
    if (pr.mergedAt) {
      const t = Date.parse(pr.mergedAt);
      if (Number.isFinite(untilMs) && t >= untilMs) continue;
      if (Number.isFinite(sinceMs) && t < sinceMs) continue;
    }
    prsMerged += 1;
    additions += nonNeg(pr.additions);
    deletions += nonNeg(pr.deletions);
  }

  // Non-merge = commits with fewer than 2 parents (excludes merge commits that
  // inflate repos which use merge commits rather than squash).
  let nonMergeCommits = 0;
  for (const c of commits) {
    const parents = Array.isArray(c.parents) ? c.parents.length : 0;
    if (parents >= 2) continue;
    // Prefer committer date; fall back to author date.
    const dateStr = c.commit?.committer?.date ?? c.commit?.author?.date;
    if (dateStr) {
      const t = Date.parse(dateStr);
      if (Number.isFinite(untilMs) && t >= untilMs) continue;
      if (Number.isFinite(sinceMs) && t < sinceMs) continue;
    }
    nonMergeCommits += 1;
  }

  return {
    repo,
    nonMergeCommits,
    prsMerged,
    linesChanged: additions + deletions,
    additions,
    deletions,
  };
}

export async function gatherAllRepoEffortMetrics(
  repos: readonly string[],
  options: GatherEffortOptions,
): Promise<RepoEffortMetrics[]> {
  const out: RepoEffortMetrics[] = [];
  for (const repo of repos) {
    out.push(await gatherRepoEffortMetrics(repo, options));
  }
  return out;
}

async function listMergedPrs(
  runGh: GhRunner,
  repo: string,
  sinceDay: string,
  limit: number,
): Promise<GhMergedPr[]> {
  const stdout = await runGh([
    'pr',
    'list',
    '-R',
    repo,
    '--state',
    'merged',
    '--search',
    `merged:>=${sinceDay}`,
    '--limit',
    String(limit),
    '--json',
    'number,additions,deletions,mergedAt',
  ]);
  const parsed = JSON.parse(stdout || '[]') as unknown;
  return Array.isArray(parsed) ? (parsed as GhMergedPr[]) : [];
}

/**
 * List commits in [since, until) via the REST commits API. Paginate with
 * `gh api --paginate`. Each page is a JSON array; gh concatenates pages so the
 * result may be a single array or concatenated arrays depending on version —
 * we normalize both.
 */
async function listCommits(
  runGh: GhRunner,
  repo: string,
  sinceIso: string,
  untilIso: string,
): Promise<GhCommit[]> {
  // `gh api --paginate` with an array resource returns NDJSON of page arrays
  // on some versions and a single concatenated JSON array on others. Accept
  // both shapes.
  const path =
    `repos/${repo}/commits?since=${encodeURIComponent(sinceIso)}` +
    `&until=${encodeURIComponent(untilIso)}&per_page=100`;
  const stdout = await runGh(['api', '--paginate', path]);
  return parsePaginatedJsonArray<GhCommit>(stdout);
}

/** Parse `gh api --paginate` stdout that may be one array or many concatenated arrays / NDJSON. */
export function parsePaginatedJsonArray<T>(stdout: string): T[] {
  const text = (stdout ?? '').trim();
  if (!text) return [];

  // Fast path: single JSON array.
  try {
    const once = JSON.parse(text) as unknown;
    if (Array.isArray(once)) return once as T[];
  } catch {
    // fall through to multi-chunk parse
  }

  // NDJSON of arrays, or concatenated `][` arrays.
  const chunks: T[] = [];
  // Split on newlines first (NDJSON); if a line is a full array, take it.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    for (const line of lines) {
      try {
        const v = JSON.parse(line) as unknown;
        if (Array.isArray(v)) chunks.push(...(v as T[]));
      } catch {
        // ignore corrupt line
      }
    }
    if (chunks.length > 0) return chunks;
  }

  // Concatenated arrays: `][` → `],[` then wrap.
  try {
    const wrapped = `[${text.replace(/\]\s*\[/g, '],[')}]`;
    const nested = JSON.parse(wrapped) as unknown;
    if (Array.isArray(nested)) {
      for (const page of nested) {
        if (Array.isArray(page)) chunks.push(...(page as T[]));
      }
      return chunks;
    }
  } catch {
    // give up
  }
  return [];
}

function nonNeg(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}
