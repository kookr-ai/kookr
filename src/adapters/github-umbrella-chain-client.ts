import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isValidIsoTimestamp } from '../core/iso-timestamp.js';

const execFile = promisify(execFileCallback);

export interface UmbrellaIssueComment {
  body: string;
}
export interface UmbrellaIssue {
  number: number;
  body: string;
  comments: readonly UmbrellaIssueComment[];
}

export interface OpenIssueSummary {
  number: number;
}

export interface UmbrellaChainRemote {
  listOpenIssues(repo: string): Promise<readonly OpenIssueSummary[]>;
  getIssue(repo: string, issueNumber: number): Promise<UmbrellaIssue | null>;
  updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void>;
  refreshBase(repoPath: string, baseBranch: string): Promise<void>;
  isPullRequestReachable(repoPath: string, baseBranch: string, prNumber: number, repo: string): Promise<boolean>;
  getPullRequestMergedAt(repo: string, prNumber: number): Promise<string | null>;
  /** Current head is required to bind an independent review to the exact diff. */
  getPullRequestHeadSha(repo: string, prNumber: number): Promise<string | null>;
}

export interface GhUmbrellaChainClientOptions {
  exec?: typeof execFile;
}

interface GhIssueView {
  body?: unknown;
  comments?: Array<{ body?: unknown }>;
}

interface GhPullRequestView {
  state?: unknown;
  mergeCommit?: { oid?: unknown } | null;
  mergedAt?: unknown;
  commits?: Array<{ oid?: unknown }>;
}

function json<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

/** Small `gh`/`git` boundary used by the advancer; all policy remains testable above it. */
export class GhUmbrellaChainClient implements UmbrellaChainRemote {
  private readonly run: typeof execFile;

  constructor(options: GhUmbrellaChainClientOptions = {}) {
    this.run = options.exec ?? execFile;
  }

  async listOpenIssues(repo: string): Promise<readonly OpenIssueSummary[]> {
    const { stdout } = await this.run('gh', [
      'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number',
    ], { timeout: 20_000 });
    const rows = json<unknown>(stdout);
    if (!Array.isArray(rows)) throw new Error('gh issue list returned a non-array payload');
    return rows.flatMap((row): OpenIssueSummary[] => {
      if (!row || typeof row !== 'object') return [];
      const value = row as { number?: unknown };
      return typeof value.number === 'number' && Number.isInteger(value.number)
        ? [{ number: value.number }]
        : [];
    });
  }

  async getIssue(repo: string, issueNumber: number): Promise<UmbrellaIssue | null> {
    try {
      const { stdout } = await this.run('gh', [
        'issue', 'view', String(issueNumber), '--repo', repo, '--json', 'body,comments',
      ], { timeout: 20_000 });
      const value = json<GhIssueView>(stdout);
      if (typeof value.body !== 'string') return null;
      return {
        number: issueNumber,
        body: value.body,
        comments: Array.isArray(value.comments)
          ? value.comments.flatMap((comment) => typeof comment?.body === 'string'
            ? [{ body: comment.body }]
            : [])
          : [],
      };
    } catch {
      return null;
    }
  }

  async updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.run('gh', [
      'api', `repos/${repo}/issues/${issueNumber}`, '-X', 'PATCH', '-f', `body=${body}`,
    ], { timeout: 20_000 });
  }

  async refreshBase(repoPath: string, baseBranch: string): Promise<void> {
    await this.run('git', ['-C', repoPath, 'fetch', '--prune', 'origin', baseBranch], { timeout: 30_000 });
  }

  async isPullRequestReachable(
    repoPath: string,
    baseBranch: string,
    prNumber: number,
    repo: string,
  ): Promise<boolean> {
    try {
      const { stdout } = await this.run('gh', [
        'pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergeCommit',
      ], { timeout: 20_000 });
      const pr = json<GhPullRequestView>(stdout);
      const mergeCommit = pr.mergeCommit?.oid;
      if (pr.state !== 'MERGED' || typeof mergeCommit !== 'string' || mergeCommit.length === 0) return false;
      await this.run('git', [
        '-C', repoPath, 'merge-base', '--is-ancestor', mergeCommit, `origin/${baseBranch}`,
      ], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async getPullRequestMergedAt(repo: string, prNumber: number): Promise<string | null> {
    try {
      const { stdout } = await this.run('gh', [
        'pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergedAt',
      ], { timeout: 20_000 });
      const pr = json<GhPullRequestView>(stdout);
      return typeof pr.mergedAt === 'string'
        && pr.mergedAt.length > 0
        && isValidIsoTimestamp(pr.mergedAt)
        ? pr.mergedAt
        : null;
    } catch {
      return null;
    }
  }

  async getPullRequestHeadSha(repo: string, prNumber: number): Promise<string | null> {
    try {
      const { stdout } = await this.run('gh', [
        'pr', 'view', String(prNumber), '--repo', repo, '--json', 'commits',
      ], { timeout: 20_000 });
      const pr = json<GhPullRequestView>(stdout);
      const oid = pr.commits?.at(-1)?.oid;
      return typeof oid === 'string' && oid.length > 0 ? oid.toLowerCase() : null;
    } catch {
      return null;
    }
  }
}
