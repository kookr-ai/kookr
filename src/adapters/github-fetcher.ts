import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GitHubFetcher,
  GitHubReference,
  GitHubPRState,
  GitHubIssueState,
  GitHubCheck,
  GitHubReviewer,
  GitHubReviewThread,
} from '../core/github-types.js';

const execFile = promisify(execFileCb);

/**
 * Fetches GitHub PR and issue state using the `gh` CLI.
 * All methods are async to avoid blocking the event loop.
 */

/** Check if `gh` CLI is available and authenticated. */
export async function isGhAvailable(): Promise<boolean> {
  try {
    await execFile('gh', ['auth', 'status'], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Infer owner/repo from a working directory's git remote. */
export async function inferOwnerRepo(cwd: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 5000,
    });
    const url = stdout.trim();

    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

    return null;
  } catch {
    return null;
  }
}

/** Fetch PR summary via gh pr view. */
export async function fetchPRState(ref: GitHubReference): Promise<GitHubPRState | null> {
  try {
    const { stdout: json } = await execFile('gh', [
      'pr', 'view', String(ref.number),
      '--repo', `${ref.owner}/${ref.repo}`,
      '--json', 'title,state,author,headRefName,baseRefName,reviewDecision,isDraft,comments',
    ], {
      timeout: 15000,
    });

    const data = JSON.parse(json);
    const status = data.isDraft ? 'draft'
      : data.state === 'MERGED' ? 'merged'
      : data.state === 'CLOSED' ? 'closed'
      : 'open';

    const reviewDecision = data.reviewDecision === 'APPROVED' ? 'approved'
      : data.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested'
      : data.reviewDecision === 'REVIEW_REQUIRED' ? 'review_required'
      : null;

    // Fetch checks
    const checks = await fetchPRChecks(ref);

    // Fetch review threads
    const { threads, reviewers } = await fetchPRReviewThreads(ref);

    return {
      ref,
      title: data.title ?? '',
      status: status as GitHubPRState['status'],
      author: data.author?.login ?? '',
      branch: data.headRefName ?? '',
      baseBranch: data.baseRefName ?? '',
      reviewDecision,
      reviewers,
      unresolvedThreads: threads.filter((t) => !t.isResolved),
      totalComments: Array.isArray(data.comments) ? data.comments.length : 0,
      checks,
      lastFetchedAt: new Date(),
    };
  } catch (err) {
    console.error(`Failed to fetch PR ${ref.owner}/${ref.repo}#${ref.number}:`, err);
    return null;
  }
}

/** Fetch PR CI checks. */
async function fetchPRChecks(ref: GitHubReference): Promise<GitHubCheck[]> {
  try {
    const { stdout: json } = await execFile('gh', [
      'pr', 'checks', String(ref.number),
      '--repo', `${ref.owner}/${ref.repo}`,
      '--json', 'name,state,conclusion',
    ], {
      timeout: 15000,
    });

    const data = JSON.parse(json);
    if (!Array.isArray(data)) return [];

    return data.map((c: { name: string; state: string; conclusion: string }) => ({
      name: c.name ?? '',
      status: mapCheckStatus(c.state),
      conclusion: mapCheckConclusion(c.conclusion),
    }));
  } catch {
    return [];
  }
}

function mapCheckStatus(state: string): GitHubCheck['status'] {
  switch (state?.toUpperCase()) {
    case 'QUEUED': return 'queued';
    case 'IN_PROGRESS': return 'in_progress';
    case 'COMPLETED': return 'completed';
    default: return 'completed';
  }
}

function mapCheckConclusion(conclusion: string): GitHubCheck['conclusion'] {
  switch (conclusion?.toUpperCase()) {
    case 'SUCCESS': return 'success';
    case 'FAILURE': return 'failure';
    case 'NEUTRAL': return 'neutral';
    case 'CANCELLED': return 'cancelled';
    case 'TIMED_OUT': return 'timed_out';
    case 'SKIPPED': return 'skipped';
    default: return null;
  }
}

/** Fetch PR review threads and reviewers via GraphQL. */
async function fetchPRReviewThreads(ref: GitHubReference): Promise<{
  threads: GitHubReviewThread[];
  reviewers: GitHubReviewer[];
}> {
  try {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { author { login } body path line createdAt }
          }
        }
      }
      reviews(first: 20) {
        nodes {
          author { login }
          state
        }
      }
    }
  }
}`;

    const { stdout: json } = await execFile('gh', [
      'api', 'graphql',
      '-f', `query=${query}`,
      '-F', `owner=${ref.owner}`,
      '-F', `repo=${ref.repo}`,
      '-F', `number=${ref.number}`,
    ], {
      timeout: 15000,
    });

    const data = JSON.parse(json);
    const pr = data?.data?.repository?.pullRequest;
    if (!pr) return { threads: [], reviewers: [] };

    const threads: GitHubReviewThread[] = (pr.reviewThreads?.nodes ?? []).map(
      (t: { id: string; isResolved: boolean; comments: { nodes: Array<{ author: { login: string }; body: string; path?: string; line?: number; createdAt: string }> } }) => {
        const comment = t.comments?.nodes?.[0];
        return {
          id: t.id,
          isResolved: t.isResolved,
          author: comment?.author?.login ?? 'unknown',
          body: comment?.body ?? '',
          path: comment?.path,
          line: comment?.line,
          createdAt: comment?.createdAt ?? '',
        };
      },
    );

    const reviewerMap = new Map<string, GitHubReviewer>();
    for (const review of pr.reviews?.nodes ?? []) {
      const login = review.author?.login;
      if (!login) continue;
      // Keep the most recent review state per reviewer
      reviewerMap.set(login, {
        login,
        state: mapReviewState(review.state),
      });
    }

    return {
      threads,
      reviewers: Array.from(reviewerMap.values()),
    };
  } catch {
    return { threads: [], reviewers: [] };
  }
}

function mapReviewState(state: string): GitHubReviewer['state'] {
  switch (state?.toUpperCase()) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes_requested';
    case 'COMMENTED': return 'commented';
    case 'DISMISSED': return 'dismissed';
    default: return 'pending';
  }
}

/** Fetch issue summary. */
export async function fetchIssueState(ref: GitHubReference): Promise<GitHubIssueState | null> {
  try {
    const { stdout: json } = await execFile('gh', [
      'issue', 'view', String(ref.number),
      '--repo', `${ref.owner}/${ref.repo}`,
      '--json', 'title,state,author,labels,comments',
    ], {
      timeout: 15000,
    });

    const data = JSON.parse(json);

    return {
      ref,
      title: data.title ?? '',
      status: data.state === 'CLOSED' ? 'closed' : 'open',
      author: data.author?.login ?? '',
      labels: Array.isArray(data.labels) ? data.labels.map((l: { name: string }) => l.name) : [],
      commentCount: Array.isArray(data.comments) ? data.comments.length : 0,
      lastFetchedAt: new Date(),
    };
  } catch (err) {
    console.error(`Failed to fetch issue ${ref.owner}/${ref.repo}#${ref.number}:`, err);
    return null;
  }
}

/** Concrete GitHubFetcher backed by the `gh` CLI. */
export const ghCliFetcher: GitHubFetcher = {
  isAvailable: isGhAvailable,
  inferOwnerRepo,
  fetchPRState,
  fetchIssueState,
};
