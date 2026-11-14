/**
 * Branch-keyed delivery probe for the TTL reapers' disposition label
 * (issue #3578).
 *
 * The reapers' first-choice delivery probe (`resolveMergedPr`) reads the
 * in-memory `GitHubStateStore`. That store holds only the PR references the
 * scanner saw in this process's hook stream, so it can come back empty for a
 * task that really did merge its PR. Task 02107c4f is the known case: its
 * `gh pr create` result does parse to #3575, and the store keeps each task's
 * references separate, yet the probe still returned nothing at reap time.
 *
 * This probe asks GitHub directly instead: "is there a merged PR whose head is
 * the branch this task's session was on?" It exists only to choose the
 * disposition label (`delivered_then_hung` vs `terminated`) for a task that
 * is already being terminated. It must never feed an auto-complete path.
 *
 * Guards against claiming someone else's delivery:
 * - the branch comes from the task's latest session only, and that session
 *   must sit in a linked git worktree. A session left in a shared checkout
 *   (the main repo, which may be on another task's feature branch) does not
 *   count, and neither does an older session's branch;
 * - never a default branch (`main`, `master`, …): a PR "from main" says
 *   nothing about which task delivered it;
 * - the head ref must match the branch exactly, from the same repository
 *   (a fork PR that happens to reuse the branch name does not count);
 * - the PR must have been *opened* at or after the task was created, so a
 *   branch another task had already PR'd before this one started does not
 *   count.
 */

import type { Task } from '../core/tasks.js';
import type { MergedPrAttribution } from '../core/completion/index.js';
import { sanitizeGithubOwnerRepo } from '../core/project-identity.js';
import { execGh } from '../adapters/gh-cli-transport.js';

/** Branch names that never identify a single task's delivery. */
const DEFAULT_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'trunk', 'head']);

/** Default bound on the `gh pr list` call (ms). */
export const DEFAULT_MERGED_PR_BY_BRANCH_TIMEOUT_MS = 10_000;

export interface MergedPrBranchProbeTarget {
  owner: string;
  repo: string;
  branch: string;
  /** Task creation time (epoch ms); a PR merged before it is not this task's. */
  notBeforeMs: number;
}

/**
 * Pick what to ask GitHub for a task, or null when the task carries no usable
 * evidence: no `github.com/<owner>/<repo>` project id, no session branch, a
 * default branch, or an unparseable creation time.
 */
export function pickMergedPrBranchProbeTarget(task: Task): MergedPrBranchProbeTarget | null {
  const projectMatch = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(task.projectId?.trim() ?? '');
  if (!projectMatch) return null;
  const safe = sanitizeGithubOwnerRepo(projectMatch[1], projectMatch[2]);
  if (!safe) return null;

  // Latest session only: an older session's branch may be work the task left.
  const session = task.sessions[task.sessions.length - 1];
  const branch = session?.gitBranch?.trim();
  if (!branch || DEFAULT_BRANCH_NAMES.has(branch.toLowerCase())) return null;
  // A shared checkout's branch may belong to someone else's work.
  if (session?.gitIsWorktree !== true) return null;

  // Persisted records can surface createdAt as an ISO string; accept both.
  const createdAt: unknown = task.createdAt;
  const notBeforeMs = createdAt instanceof Date
    ? createdAt.getTime()
    : typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(notBeforeMs)) return null;

  return { owner: safe.owner, repo: safe.repo, branch, notBeforeMs };
}

/** One row of `gh pr list --json number,url,createdAt,mergedAt,headRefName,isCrossRepository`. */
export interface MergedPrListRow {
  number?: unknown;
  url?: unknown;
  createdAt?: unknown;
  mergedAt?: unknown;
  headRefName?: unknown;
  isCrossRepository?: unknown;
}

/**
 * Choose the delivered PR from `gh pr list` rows: exact head-branch match,
 * opened at or after `notBeforeMs`, and merged. Picks the earliest qualifying
 * merge so the label names the PR that first delivered the work.
 */
export function selectMergedPrForBranch(
  rows: readonly MergedPrListRow[],
  target: Pick<MergedPrBranchProbeTarget, 'owner' | 'repo' | 'branch' | 'notBeforeMs'>,
): MergedPrAttribution | null {
  let best: { attribution: MergedPrAttribution; mergedAtMs: number } | null = null;
  for (const row of rows) {
    if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number <= 0) continue;
    if (row.headRefName !== target.branch) continue;
    if (row.isCrossRepository !== false) continue;
    if (typeof row.createdAt !== 'string' || typeof row.mergedAt !== 'string') continue;
    const openedAtMs = Date.parse(row.createdAt);
    if (!Number.isFinite(openedAtMs) || openedAtMs < target.notBeforeMs) continue;
    const mergedAtMs = Date.parse(row.mergedAt);
    if (!Number.isFinite(mergedAtMs)) continue;
    if (best && best.mergedAtMs <= mergedAtMs) continue;
    best = {
      mergedAtMs,
      attribution: {
        prNumber: row.number,
        ...(typeof row.url === 'string' && row.url.length > 0 ? { prUrl: row.url } : {}),
        owner: target.owner,
        repo: target.repo,
      },
    };
  }
  return best?.attribution ?? null;
}

export interface MergedPrByBranchProbeDeps {
  /** Runs `gh` with args; defaults to the shared gh CLI transport. */
  runGh?: (args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
  timeoutMs?: number;
}

/**
 * Build the production probe. Any failure (no target, gh error, timeout,
 * malformed JSON) resolves to null, which the reaper reads as "no confirmed
 * delivery" — the same label it would have recorded without this probe.
 */
export function createMergedPrByBranchProbe(
  deps: MergedPrByBranchProbeDeps = {},
): (task: Task) => Promise<MergedPrAttribution | null> {
  const runGh = deps.runGh ?? execGh;
  const timeout = deps.timeoutMs ?? DEFAULT_MERGED_PR_BY_BRANCH_TIMEOUT_MS;
  return async (task) => {
    const target = pickMergedPrBranchProbeTarget(task);
    if (!target) return null;
    try {
      const { stdout } = await runGh(
        [
          'pr', 'list',
          '--repo', `${target.owner}/${target.repo}`,
          '--head', target.branch,
          '--state', 'merged',
          '--json', 'number,url,createdAt,mergedAt,headRefName,isCrossRepository',
          '--limit', '20',
        ],
        { timeout },
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return null;
      return selectMergedPrForBranch(parsed as MergedPrListRow[], target);
    } catch (err) {
      console.warn(
        `[merged-pr-by-branch] probe failed for task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  };
}
