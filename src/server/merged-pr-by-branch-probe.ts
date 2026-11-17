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
 * - never a default branch (`main`, `master`, …) nor the repository's
 *   configured integration branch (`.kookr/delivery-gate.json`, #3797): a PR
 *   "from main" or "from staging" says nothing about which task delivered it;
 * - the head ref must match the branch exactly, from the same repository
 *   (a fork PR that happens to reuse the branch name does not count);
 * - the PR must have been *opened* at or after the task was created, so a
 *   branch another task had already PR'd before this one started does not
 *   count;
 * - the PR must have been merged into the repository's default or integration
 *   branch when those are known (issue #4077, the rule the store resolver
 *   applies since #3983): a merge into another feature branch delivers
 *   nothing yet. The tracker knows those branches only for repositories
 *   whose PRs the store already tracks, which this fallback usually lacks
 *   (after a restart, or for a repository with no tracked PR). On that cold
 *   cache the probe reads the default branch itself from the task's
 *   checkout (`origin/HEAD`, else `git ls-remote`; issue #4093). When the
 *   default branch is still unknown, or the row carries no base branch, the
 *   PR counts, as it did before.
 */

import type { Task } from '../core/tasks.js';
import type { MergedPrAttribution } from '../core/completion/index.js';
import { sanitizeGithubOwnerRepo } from '../core/project-identity.js';
import { execGh } from '../adapters/gh-cli-transport.js';
import { readIntegrationBranch } from '../core/delivery-gate-config.js';
import {
  createDefaultBranchReader,
  deliveryBranchList,
  type DeliveryBranches,
} from './pr-delivery-tracker.js';

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
 * default branch, the integration branch, or an unparseable creation time.
 */
export function pickMergedPrBranchProbeTarget(
  task: Task,
  integrationBranch: string | null = null,
): MergedPrBranchProbeTarget | null {
  const projectMatch = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(task.projectId?.trim() ?? '');
  if (!projectMatch) return null;
  const safe = sanitizeGithubOwnerRepo(projectMatch[1], projectMatch[2]);
  if (!safe) return null;

  // Latest session only: an older session's branch may be work the task left.
  const session = task.sessions[task.sessions.length - 1];
  const branch = session?.gitBranch?.trim();
  if (!branch || DEFAULT_BRANCH_NAMES.has(branch.toLowerCase())) return null;
  if (integrationBranch !== null && branch === integrationBranch) return null;
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

/** One row of `gh pr list --json number,url,createdAt,mergedAt,headRefName,baseRefName,isCrossRepository`. */
export interface MergedPrListRow {
  number?: unknown;
  url?: unknown;
  createdAt?: unknown;
  mergedAt?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  isCrossRepository?: unknown;
}

/**
 * Choose the delivered PR from `gh pr list` rows: exact head-branch match,
 * opened at or after `notBeforeMs`, merged, and merged into one of
 * `deliveryBranches` when that list is given (issue #4077). Picks the
 * earliest qualifying merge so the label names the PR that first delivered
 * the work.
 */
export function selectMergedPrForBranch(
  rows: readonly MergedPrListRow[],
  target: Pick<MergedPrBranchProbeTarget, 'owner' | 'repo' | 'branch' | 'notBeforeMs'>,
  deliveryBranches?: readonly string[],
): MergedPrAttribution | null {
  let best: { attribution: MergedPrAttribution; mergedAtMs: number } | null = null;
  for (const row of rows) {
    if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number <= 0) continue;
    if (row.headRefName !== target.branch) continue;
    if (row.isCrossRepository !== false) continue;
    // Same rule as the store resolver (#3983): reject only a base branch that
    // is known and is not a delivery branch.
    if (
      deliveryBranches && deliveryBranches.length > 0
      && typeof row.baseRefName === 'string' && row.baseRefName !== ''
      && !deliveryBranches.includes(row.baseRefName)
    ) continue;
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
  /**
   * The integration branch of the repository the task ran in, or null. The
   * default reads `.kookr/delivery-gate.json` from the latest session's cwd.
   */
  readIntegrationBranch?: (task: Task) => Promise<string | null>;
  /**
   * The branches a merge into counts as delivery for `owner/repo` (issue
   * #4077): production passes `PrDeliveryTracker.getDeliveryBranches`, the
   * same lookup the store resolver uses (#3983). When it has no default
   * branch for the repository (absent, undefined, or a null `defaultBranch`),
   * the probe reads one from the task's checkout instead (issue #4093).
   */
  deliveryBranchesOf?: (owner: string, repo: string) => DeliveryBranches | undefined;
  /**
   * The default branch of the repository the task ran in, or null (issue
   * #4093). Used only when `deliveryBranchesOf` does not know it. The default
   * reads `origin/HEAD` from the latest session's cwd, then the task's cwd,
   * with a cached `git ls-remote --symref origin HEAD` fallback.
   */
  readDefaultBranch?: (task: Task) => Promise<string | null>;
}

/** The task's checkouts to read repository facts from: the session's worktree may already be gone. */
function checkoutsOfTask(task: Task): string[] {
  const candidates = [task.sessions[task.sessions.length - 1]?.cwd, task.cwd];
  return [...new Set(candidates.filter((c): c is string => typeof c === 'string' && c !== ''))];
}

async function integrationBranchOfTask(task: Task): Promise<string | null> {
  for (const cwd of checkoutsOfTask(task)) {
    const branch = await readIntegrationBranch(cwd);
    if (branch !== null) return branch;
  }
  return null;
}

function defaultBranchOfTaskReader(): (task: Task) => Promise<string | null> {
  const readDefaultBranch = createDefaultBranchReader();
  return async (task) => {
    for (const cwd of checkoutsOfTask(task)) {
      const branch = await readDefaultBranch(cwd);
      if (branch !== null) return branch;
    }
    return null;
  };
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
  const resolveIntegration = deps.readIntegrationBranch ?? integrationBranchOfTask;
  const resolveDefault = deps.readDefaultBranch ?? defaultBranchOfTaskReader();
  return async (task) => {
    // Cheap checks first: only a candidate task pays for the config read.
    if (!pickMergedPrBranchProbeTarget(task)) return null;
    const integrationBranch = await resolveIntegration(task).catch(() => null);
    const target = pickMergedPrBranchProbeTarget(task, integrationBranch);
    if (!target) return null;
    try {
      const { stdout } = await runGh(
        [
          'pr', 'list',
          '--repo', `${target.owner}/${target.repo}`,
          '--head', target.branch,
          '--state', 'merged',
          '--json', 'number,url,createdAt,mergedAt,headRefName,baseRefName,isCrossRepository',
          '--limit', '20',
        ],
        { timeout },
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return null;
      const rows = parsed as MergedPrListRow[];
      let branches = deps.deliveryBranchesOf?.(target.owner, target.repo);
      // Cold tracker cache (issue #4093): learn the default branch from the
      // task's checkout, but only when a row has a base branch to check. The
      // integration branch comes from the same checkout; a failed read of it
      // looks like "no train", so a merge into staging would then not count.
      if (!branches?.defaultBranch && rows.some((r) => typeof r?.baseRefName === 'string' && r.baseRefName !== '')) {
        branches = {
          defaultBranch: await resolveDefault(task).catch(() => null),
          integrationBranch: branches?.integrationBranch ?? integrationBranch,
        };
      }
      return selectMergedPrForBranch(rows, target, deliveryBranchList(branches));
    } catch (err) {
      console.warn(
        `[merged-pr-by-branch] probe failed for task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  };
}
