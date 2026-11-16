/**
 * Keeps each tracked PR's delivery state current (issue #3915): open, in the
 * integration branch awaiting the train, on `main`, or reverted by the train.
 *
 * It asks GitHub nothing. The PR's base branch, merge time and merge commit
 * come from the state the GitHub scanner already fetched; everything else is
 * local:
 * - the repository's integration branch (`.kookr/delivery-gate.json` on `origin/main`);
 * - whether `origin/main` contains the merge commit (`git merge-base --is-ancestor`).
 *   The train fetches and pushes in a worktree of the same repository every
 *   cycle, so these remote-tracking refs stay fresh without polling;
 * - the train's revert commit (trailer `Kookr-Integration-Train: revert`) on
 *   the integration branch, its `events.jsonl` (fix attempt) and its
 *   `verify-<sha>.log` (failing tests).
 *
 * A merged PR stops changing once it is on `main` or reverted, so those
 * results are cached; only PRs still in the integration branch are re-checked
 * on each refresh. See src/core/pr-delivery-state.ts for the rules.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readIntegrationBranch } from '../core/delivery-gate-config.js';
import type { GitHubPRState, GitHubReference } from '../core/github-types.js';
import { TRAIN_TARGET_BRANCH } from '../core/integration-branch.js';
import {
  derivePrDeliveryState,
  failingTestsFromVerifyLog,
  parseTrainEvents,
  revertFactsFromTrainEvents,
  type PrDeliveryFacts,
  type TrainEventLine,
} from '../core/pr-delivery-state.js';
import type { PrDeliveryState } from '../shared/contracts/pr-delivery.js';
import { effectiveIntegrationTrainStateDir, integrationTrainPaths, resolveRepoKey } from './integration-train-runtime.js';

/** Exit code and output of one git command; code is null when git could not run. */
export type DeliveryGit = (args: string[], cwd: string) => Promise<{ code: number | null; stdout: string }>;

const defaultGit: DeliveryGit = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (!err) return resolve({ code: 0, stdout: String(stdout) });
    const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null;
    resolve({ code, stdout: String(stdout ?? '') });
  });
});

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export interface PrDeliveryTrackerDeps {
  store: {
    getAllPRStates(): GitHubPRState[];
    setPRDelivery(ref: GitHubReference, delivery: PrDeliveryState | undefined): boolean;
  };
  /** A local checkout of `owner/repo` (any worktree), or null when the server has none. */
  resolveRepoPath: (owner: string, repo: string, taskId: string) => string | null;
  kookrDir: string;
  /** Called once per task whose PR delivery changed in a refresh. */
  onDeliveryChanged: (taskId: string) => void;
  git?: DeliveryGit;
  readText?: (path: string) => string | null;
  /** Train state directory of a checkout; defaults to the train's own resolution. */
  trainStateDir?: (repoPath: string) => string;
}

interface RepoFacts {
  integrationBranch: string | null;
  integrationSince?: string;
  trainDir: string;
  events?: TrainEventLine[];
}

/** How many of `origin/main`'s reflog entries are searched for the promotion time. */
const REFLOG_DEPTH = 500;

export class PrDeliveryTracker {
  private readonly git: DeliveryGit;
  private readonly readText: (path: string) => string | null;
  private readonly trainStateDir: (repoPath: string) => string;
  /** Final results (on main, reverted) by PR identity + merge commit. */
  private readonly settled = new Map<string, PrDeliveryState>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PrDeliveryTrackerDeps) {
    this.git = deps.git ?? defaultGit;
    this.readText = deps.readText ?? defaultReadText;
    this.trainStateDir = deps.trainStateDir
      ?? ((repoPath) => effectiveIntegrationTrainStateDir(deps.kookrDir, resolveRepoKey(repoPath)));
  }

  /** Refresh every `intervalMs` (the train's own cycle is 60 s). The timer does not hold the process open. */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Recompute every tracked PR's delivery state. Calls made while one runs are
   * folded into a single follow-up run, so a burst of scanner updates costs
   * at most two passes.
   */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.refreshOnce();
        } while (this.again);
      } catch (err) {
        console.warn('[pr-delivery] refresh failed:', err instanceof Error ? err.message : err);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async refreshOnce(): Promise<void> {
    const repos = new Map<string, RepoFacts | null>();
    const changed = new Set<string>();
    for (const pr of this.deps.store.getAllPRStates()) {
      const repoPath = this.deps.resolveRepoPath(pr.ref.owner, pr.ref.repo, pr.ref.taskId);
      let delivery: PrDeliveryState | null = null;
      if (repoPath) {
        if (!repos.has(repoPath)) repos.set(repoPath, await this.readRepoFacts(repoPath));
        const repo = repos.get(repoPath) ?? null;
        if (repo) delivery = await this.deliveryOf(pr, repoPath, repo);
      }
      if (this.deps.store.setPRDelivery(pr.ref, delivery ?? undefined)) changed.add(pr.ref.taskId);
    }
    for (const taskId of changed) this.deps.onDeliveryChanged(taskId);
  }

  private async readRepoFacts(repoPath: string): Promise<RepoFacts | null> {
    const integrationBranch = await readIntegrationBranch(repoPath, async (args, cwd) => {
      const r = await this.git(args, cwd);
      return { ok: r.code === 0, stdout: r.stdout };
    });
    if (!integrationBranch) return null;
    const added = await this.git(
      ['log', '-1', '--diff-filter=A', '--format=%cI', `origin/${TRAIN_TARGET_BRANCH}`, '--', '.kookr/delivery-gate.json'],
      repoPath,
    );
    const since = added.code === 0 ? added.stdout.trim() : '';
    let trainDir: string;
    try {
      trainDir = this.trainStateDir(repoPath);
    } catch {
      trainDir = '';
    }
    return { integrationBranch, ...(since ? { integrationSince: since } : {}), trainDir };
  }

  private async deliveryOf(pr: GitHubPRState, repoPath: string, repo: RepoFacts): Promise<PrDeliveryState | null> {
    const pull = {
      status: pr.status,
      baseBranch: pr.baseBranch,
      ...(iso(pr.createdAt) ? { openedAt: iso(pr.createdAt)! } : {}),
      ...(iso(pr.mergedAt) ? { mergedAt: iso(pr.mergedAt)! } : {}),
      ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}),
    };
    const facts: PrDeliveryFacts = {
      pr: pull,
      integrationBranch: repo.integrationBranch,
      ...(repo.integrationSince ? { integrationSince: repo.integrationSince } : {}),
      onMain: null,
      revert: null,
    };
    const commit = pr.mergeCommit;
    if (pr.status !== 'merged' || !commit) return derivePrDeliveryState(facts);

    if (pr.baseBranch === TRAIN_TARGET_BRANCH) {
      // Merged straight into main: it reached main when it merged.
      return derivePrDeliveryState({ ...facts, ...(pull.mergedAt ? { onMainAt: pull.mergedAt } : {}) });
    }
    if (pr.baseBranch !== repo.integrationBranch) return derivePrDeliveryState(facts);

    const cacheKey = `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}@${commit}`;
    const settled = this.settled.get(cacheKey);
    if (settled) return settled;

    const revert = await this.findRevert(commit, repoPath, repo);
    if (revert) facts.revert = revert;
    else {
      facts.onMain = await this.isOnMain(commit, repoPath);
      if (facts.onMain) {
        const at = await this.onMainSince(commit, repoPath);
        if (at) facts.onMainAt = at;
      }
    }
    const delivery = derivePrDeliveryState(facts);
    if (delivery && (delivery.stage === 'on-main' || delivery.stage === 'reverted')) this.settled.set(cacheKey, delivery);
    return delivery;
  }

  /** true / false, or null when the commit is unknown locally or git failed (exit 128). */
  private async isOnMain(commit: string, repoPath: string): Promise<boolean | null> {
    const r = await this.git(['merge-base', '--is-ancestor', commit, `origin/${TRAIN_TARGET_BRANCH}`], repoPath);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    return null;
  }

  /**
   * When the local `origin/main` first contained `commit`, from its reflog
   * (main only moves forward, so a binary search over the entries works). The
   * train pushes from a worktree of this repository, which records each
   * promotion there. Undefined when the commit predates the reflog's window.
   */
  private async onMainSince(commit: string, repoPath: string): Promise<string | undefined> {
    const log = await this.git(
      ['log', '-g', '--date=iso-strict', '--format=%H%x09%gd', '-n', String(REFLOG_DEPTH), `refs/remotes/origin/${TRAIN_TARGET_BRANCH}`],
      repoPath,
    );
    if (log.code !== 0) return undefined;
    const entries = log.stdout.split('\n').map((line) => {
      const [sha, selector] = line.split('\t');
      const at = /@\{(.+)\}$/.exec(selector ?? '')?.[1];
      return sha && at ? { sha, at } : null;
    }).filter((e): e is { sha: string; at: string } => e !== null);
    // Newest first: entries [0..k] contain the commit, the rest do not. Find k.
    let lo = 0;
    let hi = entries.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = await this.git(['merge-base', '--is-ancestor', commit, entries[mid]!.sha], repoPath);
      if (r.code === 0) {
        last = mid;
        lo = mid + 1;
      } else if (r.code === 1) {
        hi = mid - 1;
      } else {
        return undefined;
      }
    }
    // Even the oldest entry has it: it reached main before the reflog starts.
    if (last < 0 || last === entries.length - 1) return undefined;
    const ms = Date.parse(entries[last]!.at);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }

  private async findRevert(commit: string, repoPath: string, repo: RepoFacts): Promise<PrDeliveryFacts['revert']> {
    const r = await this.git([
      'log', '-n', '1', '--format=%H%x09%cI', '--fixed-strings', '--all-match',
      '--grep', `This reverts commit ${commit}`,
      '--grep', 'Kookr-Integration-Train: revert',
      `origin/${repo.integrationBranch}`,
    ], repoPath);
    if (r.code !== 0) return null;
    const [revertCommit, committedAt] = r.stdout.trim().split('\t');
    if (!revertCommit) return null;
    if (repo.trainDir && repo.events === undefined) {
      repo.events = parseTrainEvents(this.readText(integrationTrainPaths(repo.trainDir).events) ?? '');
    }
    const fromLog = revertFactsFromTrainEvents(repo.events ?? [], commit);
    const verifyLog = repo.trainDir ? this.readText(join(repo.trainDir, `verify-${commit.slice(0, 10)}.log`)) : null;
    const at = fromLog?.at ?? committedAt;
    return {
      revertCommit,
      ...(at ? { at } : {}),
      ...(fromLog?.attempt !== undefined ? { attempt: fromLog.attempt } : {}),
      ...(fromLog?.maxAttempts !== undefined ? { maxAttempts: fromLog.maxAttempts } : {}),
      ...(fromLog?.fixTaskKey ? { fixTaskKey: fromLog.fixTaskKey } : {}),
      needsHuman: fromLog?.needsHuman ?? false,
      failingTests: verifyLog ? failingTestsFromVerifyLog(verifyLog) : [],
    };
  }
}

function iso(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** `https://github.com/<owner>/<repo>/pull/<n>` → its parts, or null. */
export function parsePullRequestUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(url.trim());
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/**
 * PR references of tasks that finished within `windowMs`, read from their
 * persisted completion digest. The GitHub store lives in memory and a finished
 * task emits no event that would refill it after a restart, so without these a
 * finished task's card loses its PR, and its delivery state, at every deploy.
 */
export function finishedTaskPrReferences(
  tasks: ReadonlyArray<{ id: string; status: string; finishedAt?: Date; completionDigest?: { prUrls?: string[] } }>,
  now: Date,
  windowMs: number,
  isTerminal: (status: string) => boolean,
): GitHubReference[] {
  const refs: GitHubReference[] = [];
  for (const task of tasks) {
    if (!isTerminal(task.status) || !task.finishedAt) continue;
    if (now.getTime() - task.finishedAt.getTime() > windowMs) continue;
    for (const url of task.completionDigest?.prUrls ?? []) {
      const parsed = parsePullRequestUrl(url);
      if (!parsed) continue;
      refs.push({
        type: 'pr',
        ...parsed,
        url: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`,
        detectedAt: task.finishedAt,
        detectedFrom: 'completion-digest',
        taskId: task.id,
      });
    }
  }
  return refs;
}

/**
 * Finds a local checkout for a PR's repository: the server's own checkout when
 * its `origin` is that repository, else the task's working directory while it
 * still exists (workers delete their worktree after merging, so the server's
 * checkout comes first). Repository keys are cached per path, because reading
 * one runs git.
 */
export function createRepoPathResolver(opts: {
  serverCwd: string;
  getTaskCwd: (taskId: string) => string | undefined;
  exists: (path: string) => boolean;
  repoKeyOf?: (path: string) => string;
}): (owner: string, repo: string, taskId: string) => string | null {
  const keyOf = opts.repoKeyOf ?? resolveRepoKey;
  const keys = new Map<string, string>();
  const cachedKey = (path: string): string => {
    let key = keys.get(path);
    if (key === undefined) {
      key = keyOf(path);
      keys.set(path, key);
    }
    return key;
  };
  // A task's directory never changes; caching it keeps the once-a-minute
  // refresh from reading (and cloning) task records.
  const taskCwds = new Map<string, string | undefined>();
  return (owner, repo, taskId) => {
    const wanted = `${owner}-${repo}`.toLowerCase();
    if (cachedKey(opts.serverCwd) === wanted) return opts.serverCwd;
    if (!taskCwds.has(taskId)) taskCwds.set(taskId, opts.getTaskCwd(taskId));
    const cwd = taskCwds.get(taskId);
    if (cwd && opts.exists(cwd) && cachedKey(cwd) === wanted) return cwd;
    return null;
  };
}

/** One PR's delivery state as `/api/snapshot` reports it on an agent (`prDelivery`). */
export type SnapshotPrDelivery = { number: number; url: string } & PrDeliveryState;

/**
 * Adds `prDelivery` (each tracked PR that has a delivery state) to the
 * snapshot agents that have one, for `kookr peek` and `kookr status` (#3915).
 * Agents without one are returned as they are.
 */
export function withSnapshotPrDelivery<T extends { taskId?: string }>(
  agents: readonly T[],
  prsOf: (taskId: string) => readonly GitHubPRState[],
): Array<T | (T & { prDelivery: SnapshotPrDelivery[] })> {
  return agents.map((agent) => {
    if (!agent.taskId) return agent;
    const prDelivery = prsOf(agent.taskId)
      .filter((pr) => pr.delivery)
      .map((pr) => ({ number: pr.ref.number, url: pr.ref.url, ...pr.delivery! }));
    return prDelivery.length > 0 ? { ...agent, prDelivery } : agent;
  });
}
