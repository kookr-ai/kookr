import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GitHubFetcher,
  GitHubFetchBatchResult,
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

interface RepoRefGroup {
  owner: string;
  repo: string;
  refs: GitHubReference[];
}

interface GraphQLAuthor {
  login?: unknown;
}

interface GraphQLReviewThreadNode {
  id?: unknown;
  isResolved?: unknown;
  comments?: {
    nodes?: Array<{
      author?: GraphQLAuthor | null;
      body?: unknown;
      path?: unknown;
      line?: unknown;
      createdAt?: unknown;
    } | null>;
  } | null;
}

interface GraphQLReviewNode {
  author?: GraphQLAuthor | null;
  state?: unknown;
}

interface GraphQLStatusContextNode {
  __typename?: unknown;
  name?: unknown;
  context?: unknown;
  status?: unknown;
  conclusion?: unknown;
  state?: unknown;
}

interface GraphQLPRNode {
  title?: unknown;
  state?: unknown;
  isDraft?: unknown;
  author?: GraphQLAuthor | null;
  headRefName?: unknown;
  baseRefName?: unknown;
  reviewDecision?: unknown;
  comments?: { totalCount?: unknown } | null;
  reviewThreads?: { nodes?: Array<GraphQLReviewThreadNode | null> } | null;
  reviews?: { nodes?: Array<GraphQLReviewNode | null> } | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          contexts?: { nodes?: Array<GraphQLStatusContextNode | null> } | null;
        } | null;
      } | null;
    } | null>;
  } | null;
}

interface GraphQLIssueNode {
  title?: unknown;
  state?: unknown;
  author?: GraphQLAuthor | null;
  labels?: { nodes?: Array<{ name?: unknown } | null> } | null;
  comments?: { totalCount?: unknown } | null;
}

/** Fetch all requested PR and issue states using one GraphQL request per repository. */
export async function fetchStates(refs: GitHubReference[]): Promise<GitHubFetchBatchResult> {
  const result: GitHubFetchBatchResult = { prs: [], issues: [] };
  for (const group of groupRefsByRepo(refs)) {
    try {
      const query = buildRepoStateBatchQuery(group.refs);
      const { stdout: json } = await execFile('gh', [
        'api', 'graphql',
        '-f', `query=${query}`,
        '-F', `owner=${group.owner}`,
        '-F', `repo=${group.repo}`,
      ], {
        timeout: 15000,
      });

      const parsed: unknown = JSON.parse(json);
      const batch = parseRepoStateBatchResponse(parsed, group.refs);
      result.prs.push(...batch.prs);
      result.issues.push(...batch.issues);
    } catch (err) {
      console.error(`Failed to fetch GitHub state batch for ${group.owner}/${group.repo}:`, err);
    }
  }
  return result;
}

function groupRefsByRepo(refs: GitHubReference[]): RepoRefGroup[] {
  const groups = new Map<string, RepoRefGroup>();
  for (const ref of refs) {
    const key = `${ref.owner}/${ref.repo}`;
    const existing = groups.get(key);
    if (existing) {
      existing.refs.push(ref);
    } else {
      groups.set(key, { owner: ref.owner, repo: ref.repo, refs: [ref] });
    }
  }
  return Array.from(groups.values());
}

export function buildRepoStateBatchQuery(refs: GitHubReference[]): string {
  const selections = uniqueGitHubObjects(refs).map((ref) => {
    const field = ref.type === 'pr' ? 'pullRequest' : 'issue';
    return `${aliasForRef(ref)}: ${field}(number: ${ref.number}) {
${ref.type === 'pr' ? PR_STATE_SELECTION : ISSUE_STATE_SELECTION}
    }`;
  }).join('\n');

  return `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${selections}
  }
}`;
}

function uniqueGitHubObjects(refs: GitHubReference[]): GitHubReference[] {
  const seen = new Set<string>();
  const unique: GitHubReference[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.owner}/${ref.repo}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

const PR_STATE_SELECTION = `      title
      state
      isDraft
      author { login }
      headRefName
      baseRefName
      reviewDecision
      comments { totalCount }
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { author { login } body path line createdAt }
          }
        }
      }
      reviews(last: 20) {
        nodes {
          author { login }
          state
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }`;

const ISSUE_STATE_SELECTION = `      title
      state
      author { login }
      labels(first: 50) {
        nodes { name }
      }
      comments { totalCount }`;

export function parseRepoStateBatchResponse(data: unknown, refs: GitHubReference[]): GitHubFetchBatchResult {
  const repository = isRecord(data)
    ? getRecord(getRecord(data.data)?.repository)
    : null;
  const result: GitHubFetchBatchResult = { prs: [], issues: [] };
  if (!repository) return result;

  for (const ref of refs) {
    const node = getRecord(repository[aliasForRef(ref)]);
    if (!node) continue;
    if (ref.type === 'pr') {
      result.prs.push(parsePRNode(ref, node));
    } else {
      result.issues.push(parseIssueNode(ref, node));
    }
  }

  return result;
}

function parsePRNode(ref: GitHubReference, node: GraphQLPRNode): GitHubPRState {
  const status = node.isDraft === true ? 'draft'
    : stringValue(node.state) === 'MERGED' ? 'merged'
    : stringValue(node.state) === 'CLOSED' ? 'closed'
    : 'open';

  const reviewDecision = stringValue(node.reviewDecision) === 'APPROVED' ? 'approved'
    : stringValue(node.reviewDecision) === 'CHANGES_REQUESTED' ? 'changes_requested'
    : stringValue(node.reviewDecision) === 'REVIEW_REQUIRED' ? 'review_required'
    : null;

  const threads: GitHubReviewThread[] = arrayValue(node.reviewThreads?.nodes).map((thread) => {
    const comment = getRecord(thread?.comments?.nodes?.[0]);
    return {
      id: stringValue(thread?.id),
      isResolved: thread?.isResolved === true,
      author: stringValue(getRecord(comment?.author)?.login) || 'unknown',
      body: stringValue(comment?.body),
      path: optionalString(comment?.path),
      line: typeof comment?.line === 'number' ? comment.line : undefined,
      createdAt: stringValue(comment?.createdAt),
    };
  });

  const reviewerMap = new Map<string, GitHubReviewer>();
  for (const review of arrayValue(node.reviews?.nodes)) {
    const login = stringValue(review?.author?.login);
    if (!login) continue;
    reviewerMap.set(login, {
      login,
      state: mapReviewState(stringValue(review.state)),
    });
  }

  return {
    ref,
    title: stringValue(node.title),
    status,
    author: stringValue(node.author?.login),
    branch: stringValue(node.headRefName),
    baseBranch: stringValue(node.baseRefName),
    reviewDecision,
    reviewers: Array.from(reviewerMap.values()),
    unresolvedThreads: threads.filter((thread) => !thread.isResolved),
    totalComments: numberValue(node.comments?.totalCount),
    checks: parseChecks(node),
    lastFetchedAt: new Date(),
  };
}

function parseIssueNode(ref: GitHubReference, node: GraphQLIssueNode): GitHubIssueState {
  return {
    ref,
    title: stringValue(node.title),
    status: stringValue(node.state) === 'CLOSED' ? 'closed' : 'open',
    author: stringValue(node.author?.login),
    labels: arrayValue(node.labels?.nodes)
      .map((label) => stringValue(label?.name))
      .filter((label) => label.length > 0),
    commentCount: numberValue(node.comments?.totalCount),
    lastFetchedAt: new Date(),
  };
}

function parseChecks(node: GraphQLPRNode): GitHubCheck[] {
  const commit = node.commits?.nodes?.[0]?.commit;
  const contexts = arrayValue(commit?.statusCheckRollup?.contexts?.nodes);
  return contexts.map((context) => {
    if (stringValue(context?.__typename) === 'StatusContext') {
      return {
        name: stringValue(context?.context),
        status: mapStatusContextStatus(stringValue(context?.state)),
        conclusion: mapStatusContextConclusion(stringValue(context?.state)),
      };
    }

    return {
      name: stringValue(context?.name),
      status: mapCheckStatus(stringValue(context?.status)),
      conclusion: mapCheckConclusion(stringValue(context?.conclusion)),
    };
  });
}

function aliasForRef(ref: GitHubReference): string {
  return `${ref.type}_${ref.number}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function arrayValue<T>(value: Array<T | null | undefined> | null | undefined): Array<NonNullable<T>> {
  return Array.isArray(value)
    ? value.filter((item): item is NonNullable<T> => item !== null && item !== undefined)
    : [];
}

function mapStatusContextStatus(state: string): GitHubCheck['status'] {
  switch (state.toUpperCase()) {
    case 'PENDING':
    case 'EXPECTED':
      return 'in_progress';
    default:
      return 'completed';
  }
}

function mapStatusContextConclusion(state: string): GitHubCheck['conclusion'] {
  switch (state.toUpperCase()) {
    case 'SUCCESS': return 'success';
    case 'FAILURE':
    case 'ERROR': return 'failure';
    case 'PENDING':
    case 'EXPECTED': return null;
    default: return null;
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
  fetchStates,
  fetchPRState,
  fetchIssueState,
};
