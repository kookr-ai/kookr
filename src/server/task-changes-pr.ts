/**
 * The Changes tab's fallback once a task's worktree is gone (#4024 item 4
 * slice 3; design note docs/rfc/rfc-reading-pane-changes-tab.md): list the
 * files of the task's own pull request, as GitHub reports them, instead of a
 * local `git diff`.
 *
 * GitHub runs only when the operator opens the tab, presses Refresh or opens
 * a file, and a list is reused for a short while so opening several files
 * asks GitHub once.
 */
import { execGh } from '../adapters/gh-cli-transport.js';
import type {
  TaskChangeFileResponse,
  TaskChangeStatus,
  TaskChangedFile,
  TaskChangesResponse,
} from '../shared/contracts/task-changes.js';
import { MAX_CHANGED_FILES, parseUnifiedDiff } from './task-changes.js';

/** One entry of `GET /repos/{owner}/{repo}/pulls/{n}/files`. */
export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Absent for a binary file or a diff GitHub considers too large. */
  patch?: string;
  previous_filename?: string;
}

/** The task's own pull request the fallback reads. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
  branch: string;
  baseBranch: string;
}

/** One page of a PR's files, or `null` when GitHub could not be asked. */
export type PullRequestFilesPage = (pr: PullRequestRef, page: number) => Promise<PullRequestFile[] | null>;

/** GitHub's page size for the files endpoint. */
export const PR_FILES_PER_PAGE = 100;
/** A list is reused this long, so opening its files does not ask GitHub again. */
const CACHE_TTL_MS = 60_000;
/** Lists kept at once; the oldest is dropped first. */
const CACHE_MAX_ENTRIES = 20;
const SAFE_NAME = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

export const ghPullRequestFilesPage: PullRequestFilesPage = async (pr, page) => {
  if (!SAFE_NAME.test(pr.owner) || !SAFE_NAME.test(pr.repo) || !Number.isInteger(pr.number) || pr.number <= 0) return null;
  try {
    const { stdout } = await execGh(
      ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=${PR_FILES_PER_PAGE}&page=${page}`],
      { timeout: 15_000 },
    );
    const data: unknown = JSON.parse(stdout);
    return Array.isArray(data) ? data.filter(isPullRequestFile) : null;
  } catch {
    return null;
  }
};

function isPullRequestFile(value: unknown): value is PullRequestFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.filename === 'string' && typeof v.status === 'string';
}

function toStatus(status: string): TaskChangeStatus {
  switch (status) {
    case 'added':
    case 'copied':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    default:
      // 'modified', 'changed', 'unchanged'
      return 'modified';
  }
}

interface CachedList {
  at: number;
  files: PullRequestFile[];
  truncated: boolean;
}

interface CacheEntry {
  at: number;
  /** Shared by every request that arrives while GitHub is being asked. */
  pending: Promise<CachedList | null>;
}

/** Reads and caches pull request file lists. One per route registration. */
export class PullRequestChanges {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly fetchPage: PullRequestFilesPage = ghPullRequestFilesPage,
    private readonly now: () => number = Date.now,
  ) {}

  /** The PR's files as a change list, or `null` when GitHub could not be asked. */
  async list(pr: PullRequestRef, opts: { fresh?: boolean } = {}): Promise<TaskChangesResponse | null> {
    const cached = await this.files(pr, opts.fresh === true);
    if (!cached) return null;
    const files: TaskChangedFile[] = cached.files.map((f) => {
      // GitHub sends no patch for a binary file, and none for a pure rename either.
      const binary = f.patch === undefined && f.additions === 0 && f.deletions === 0 && f.status !== 'renamed';
      return {
        path: f.filename,
        ...(f.status === 'renamed' && f.previous_filename ? { oldPath: f.previous_filename } : {}),
        status: toStatus(f.status),
        added: binary ? null : f.additions,
        removed: binary ? null : f.deletions,
      };
    });
    return {
      kind: 'ok',
      source: 'pull_request',
      pullRequest: { number: pr.number, url: pr.url },
      baseRef: pr.baseBranch,
      branch: pr.branch,
      repoRoot: null,
      files,
      truncated: cached.truncated,
    };
  }

  /**
   * One file's patch from the PR, `null` when the path is not in the PR's
   * file list, `undefined` when GitHub could not be asked.
   */
  async file(pr: PullRequestRef, filePath: string): Promise<TaskChangeFileResponse | null | undefined> {
    const cached = await this.files(pr, false);
    if (!cached) return undefined;
    const entry = cached.files.find((f) => f.filename === filePath);
    if (!entry) return null;
    if (entry.patch === undefined) {
      return entry.status === 'renamed' && entry.additions === 0 && entry.deletions === 0
        ? { kind: 'patch', path: entry.filename, hunks: [] }
        : { kind: 'no_patch', path: entry.filename };
    }
    return { kind: 'patch', path: entry.filename, hunks: parseUnifiedDiff(entry.patch) };
  }

  private files(pr: PullRequestRef, fresh: boolean): Promise<CachedList | null> {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && !fresh && now - hit.at < CACHE_TTL_MS) return hit.pending;

    for (const [k, entry] of this.cache) {
      if (now - entry.at >= CACHE_TTL_MS) this.cache.delete(k);
    }
    this.cache.delete(key);
    while (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    const entry: CacheEntry = { at: now, pending: this.fetchAll(pr) };
    this.cache.set(key, entry);
    // A failed ask is not kept, so the next request tries again.
    void entry.pending.then((list) => {
      if (list === null && this.cache.get(key) === entry) this.cache.delete(key);
    });
    return entry.pending;
  }

  private async fetchAll(pr: PullRequestRef): Promise<CachedList | null> {
    const files: PullRequestFile[] = [];
    let truncated = false;
    const maxPages = Math.ceil(MAX_CHANGED_FILES / PR_FILES_PER_PAGE);
    for (let page = 1; ; page++) {
      const batch = await this.fetchPage(pr, page);
      if (batch === null) return null;
      files.push(...batch);
      if (batch.length < PR_FILES_PER_PAGE) break;
      if (page >= maxPages) {
        // A full last page may have more after it; say the list is cut.
        truncated = true;
        break;
      }
    }
    return { at: this.now(), files: files.slice(0, MAX_CHANGED_FILES), truncated };
  }
}
