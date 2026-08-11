import { execFile as execFileCb, spawn } from 'node:child_process';
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
  GitHubRateLimit,
  GitHubRepoHealthFetchResult,
} from '../core/github-types.js';
import type { ProjectRepoHealth } from '../core/project-summary.js';
import { isSafePullRequestUrl, projectRepoUrl } from '../core/project-identity.js';

const execFile = promisify(execFileCb);
const DEFAULT_RATE_LIMIT_RETRY_AFTER_MS = 60_000;
const DEFAULT_GH_MAX_ATTEMPTS = 3;
const DEFAULT_GH_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Fetches GitHub PR and issue state using the `gh` CLI.
 * All methods are async to avoid blocking the event loop.
 */

/** Check if `gh` CLI is available and authenticated. */
export async function isGhAvailable(): Promise<boolean> {
  try {
    await execGh(['auth', 'status'], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the authenticated GitHub login (e.g. "jeanibarz") via `gh api user`.
 * Returns null if `gh` is unavailable, the call fails, or the response is malformed.
 * Used to scope "needs attention" PR searches to the user.
 */
export async function getGhUserLogin(): Promise<string | null> {
  try {
    const { stdout } = await execGh(['api', 'user', '--jq', '.login'], {
      timeout: 5000,
    });
    const login = stdout.trim();
    if (!login || !/^[a-zA-Z0-9-]{1,39}$/.test(login)) return null;
    return login;
  } catch {
    return null;
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
    const { stdout: json } = await execGh([
      'pr', 'view', String(ref.number),
      '--repo', `${ref.owner}/${ref.repo}`,
      '--json', 'title,state,author,headRefName,baseRefName,reviewDecision,isDraft,comments,mergeable',
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
      mergeable: mapMergeable(data.mergeable),
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
  mergeable?: unknown;
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

/** Log every Nth consecutive per-repo batch failure (1st, then every Nth with running count). */
const FETCH_STATE_FAIL_LOG_EVERY = 10;
/**
 * Cap tracked repos so the failure map stays bounded (issue #1946).
 * Keys are the small set of repos Kookr actually polls; the cap is a safety rail.
 */
const FETCH_STATE_FAIL_MAX_REPOS = 64;

/** Per-repo non-rate-limit batch-failure state (issue #1946). */
interface FetchStateFailEntry {
  /** Cumulative process-lifetime failure count (Prometheus counter). */
  failures: number;
  /**
   * Consecutive failures since last success — drives log throttle only.
   * Cleared on a successful batch for that repo.
   */
  consecutive: number;
  lastError: string;
  lastAtMs: number;
}

const fetchStateFailByRepo = new Map<string, FetchStateFailEntry>();

/** Snapshot entry for `/metrics` and diagnostics (issue #1946). */
export interface GitHubStateFetchFailureSnapshotEntry {
  /** `owner/repo` label. */
  repo: string;
  /** Cumulative non-rate-limit batch failures for this process. */
  failures: number;
  lastError: string;
  lastAtMs: number;
}

/**
 * Process-lifetime per-repo state-fetch failure counters for Prometheus (issue #1946).
 * Ordered by repo label for stable exposition.
 */
export function getGitHubStateFetchFailureSnapshot(): GitHubStateFetchFailureSnapshotEntry[] {
  return Array.from(fetchStateFailByRepo.entries())
    .map(([repo, entry]) => ({
      repo,
      failures: entry.failures,
      lastError: entry.lastError,
      lastAtMs: entry.lastAtMs,
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Test-only: reset per-repo failure counters and log throttle state. */
export function resetFetchStateFailureThrottleForTests(): void {
  fetchStateFailByRepo.clear();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function ensureFetchStateFailCapacity(key: string): void {
  if (fetchStateFailByRepo.has(key)) return;
  if (fetchStateFailByRepo.size < FETCH_STATE_FAIL_MAX_REPOS) return;
  // Evict least-recently-updated entry so the map stays bounded.
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [repo, entry] of fetchStateFailByRepo) {
    if (entry.lastAtMs < oldestAt) {
      oldestAt = entry.lastAtMs;
      oldestKey = repo;
    }
  }
  if (oldestKey) fetchStateFailByRepo.delete(oldestKey);
}

function recordFetchStateBatchFailure(owner: string, repo: string, err: unknown): void {
  const key = `${owner}/${repo}`;
  ensureFetchStateFailCapacity(key);
  const prev = fetchStateFailByRepo.get(key);
  const consecutive = (prev?.consecutive ?? 0) + 1;
  const failures = (prev?.failures ?? 0) + 1;
  fetchStateFailByRepo.set(key, {
    failures,
    consecutive,
    lastError: errorMessage(err),
    lastAtMs: Date.now(),
  });
  // Throttle spam: first consecutive occurrence + every Nth thereafter, with running count.
  if (consecutive === 1 || consecutive % FETCH_STATE_FAIL_LOG_EVERY === 0) {
    const suffix = consecutive === 1 ? '' : ` (x${consecutive})`;
    console.error(`Failed to fetch GitHub state batch for ${owner}/${repo}${suffix}:`, err);
  }
}

function clearFetchStateBatchFailure(owner: string, repo: string): void {
  const key = `${owner}/${repo}`;
  const entry = fetchStateFailByRepo.get(key);
  if (!entry) return;
  // Keep cumulative failures for Prometheus; only reset the log throttle streak.
  if (entry.consecutive === 0) return;
  fetchStateFailByRepo.set(key, { ...entry, consecutive: 0 });
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Fetch all requested PR and issue states using one GraphQL request per repository. */
export async function fetchStates(refs: GitHubReference[]): Promise<GitHubFetchBatchResult> {
  const result: GitHubFetchBatchResult = { prs: [], issues: [] };
  const groups = groupRefsByRepo(refs);
  const failures: Error[] = [];
  let successGroups = 0;

  for (const group of groups) {
    try {
      const query = buildRepoStateBatchQuery(group.refs);
      const { stdout } = await execGh([
        'api', 'graphql', '--include',
        '-f', `query=${query}`,
        '-F', `owner=${group.owner}`,
        '-F', `repo=${group.repo}`,
      ], {
        timeout: 15000,
      });

      const response = splitGhApiOutput(stdout);
      const parsed: unknown = JSON.parse(response.body);
      const rateLimit = classifyGitHubRateLimit(parsed);
      if (rateLimit) {
        result.rateLimit = mergeRateLimits(result.rateLimit, rateLimit);
        console.warn(`[github] rate limited while fetching state for ${group.owner}/${group.repo}: ${rateLimit.message}`);
        return result;
      }
      const batch = parseRepoStateBatchResponse(parsed, group.refs);
      result.prs.push(...batch.prs);
      result.issues.push(...batch.issues);
      clearFetchStateBatchFailure(group.owner, group.repo);
      successGroups++;
      const headerRateLimit = classifyGitHubRateLimit(response.headers);
      if (headerRateLimit) {
        result.rateLimit = mergeRateLimits(result.rateLimit, headerRateLimit);
        console.warn(`[github] rate limited after fetching state for ${group.owner}/${group.repo}: ${headerRateLimit.message}`);
        return result;
      }
    } catch (err) {
      const rateLimit = classifyGitHubRateLimit(err) ?? classifyGitHubRateLimit(ghErrorStdout(err));
      if (rateLimit) {
        result.rateLimit = mergeRateLimits(result.rateLimit, rateLimit);
        console.warn(`[github] rate limited while fetching state for ${group.owner}/${group.repo}: ${rateLimit.message}`);
        return result;
      }
      // gh exits non-zero when any aliased field is NOT_FOUND, but stdout often
      // still carries partial data.repository with nulls for missing aliases
      // and real payloads for live ones (issue #2272).
      const partial = tryRecoverPartialRepoStateBatch(err, group.refs);
      if (partial) {
        result.prs.push(...partial.prs);
        result.issues.push(...partial.issues);
        clearFetchStateBatchFailure(group.owner, group.repo);
        successGroups++;
        continue;
      }
      recordFetchStateBatchFailure(group.owner, group.repo, err);
      failures.push(toError(err));
    }
  }

  // Total-batch non-rate-limit failure: rethrow so CircuitBreakerGitHubFetcher.breaker.call observes it.
  // Partial success (any repo group succeeded) still returns results; rate-limit returns early above.
  if (groups.length > 0 && successGroups === 0 && failures.length === groups.length) {
    throw new AggregateError(
      failures,
      `Failed to fetch GitHub state for all ${failures.length} repo group(s)`,
    );
  }

  return result;
}

function mergeRateLimits(existing: GitHubRateLimit | undefined, next: GitHubRateLimit): GitHubRateLimit {
  if (!existing || next.retryAfterMs > existing.retryAfterMs) return next;
  return existing;
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
      mergeable
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

/**
 * Recover usable PR/issue rows from a failed `gh api graphql` invocation when
 * stdout still contains a GraphQL body with `data.repository` (field-level
 * errors such as deleted-issue NOT_FOUND leave live aliases intact).
 * Returns null for transport failures, non-JSON stdout, or top-level GraphQL
 * failures with no repository object — those stay on the hard-failure path.
 * Issue #2272.
 */
function tryRecoverPartialRepoStateBatch(
  err: unknown,
  refs: GitHubReference[],
): GitHubFetchBatchResult | null {
  const stdout = ghErrorStdout(err);
  if (!stdout) return null;

  let parsed: unknown;
  try {
    const response = splitGhApiOutput(stdout);
    parsed = JSON.parse(response.body);
  } catch {
    return null;
  }

  // Require a real repository object. Top-level failures (no data, or
  // repository: null for a missing repo) must not be masked as success.
  if (!isRecord(parsed) || !getRecord(getRecord(parsed.data)?.repository)) {
    return null;
  }

  // When errors are present, only recover field-level ones (NOT_FOUND etc.).
  // Unknown/top-level GraphQL errors with no field path stay on the failure path.
  if (!areGraphQLErrorsFieldLevel(parsed)) {
    return null;
  }

  return parseRepoStateBatchResponse(parsed, refs);
}

/**
 * True when the GraphQL body has no errors, or every error looks field-scoped
 * (has a path under repository, and/or type NOT_FOUND). Rejects RATE_LIMITED
 * (already handled upstream) and bare top-level errors without a path.
 */
function areGraphQLErrorsFieldLevel(parsed: unknown): boolean {
  if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return true;
  if (parsed.errors.length === 0) return true;

  return parsed.errors.every((entry) => {
    if (!isRecord(entry)) return false;
    const type = typeof entry.type === 'string' ? entry.type.toUpperCase() : '';
    if (type === 'RATE_LIMITED') return false;
    if (type === 'NOT_FOUND') return true;
    const path = entry.path;
    // Field-level: path includes repository plus at least one alias segment.
    return Array.isArray(path) && path.length >= 2 && path[0] === 'repository';
  });
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
    mergeable: mapMergeable(node.mergeable),
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
    const { stdout: json } = await execGh([
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

function mapMergeable(value: unknown): GitHubPRState['mergeable'] {
  return value === 'MERGEABLE' || value === 'CONFLICTING' ? value : 'UNKNOWN';
}

// --- PR merge readiness (#1148 publish/merge reconciliation) ---------------

/** Merge-readiness evidence derived from an already-fetched {@link GitHubPRState}. */
export interface PRMergeReadiness {
  /** The PR is open and GitHub reports `mergeable: MERGEABLE`. */
  mergeable: boolean;
  /** No check is failing or still pending — `checks` may also be empty. */
  checksGreen: boolean;
  /** Check names still queued/in-progress. */
  pendingChecks: string[];
  /** Check names that failed or timed out. */
  failingChecks: string[];
}

/**
 * Evaluate whether a fetched PR is "green" (no failing/pending checks) and
 * mergeable, for the publish/merge state reconciler (#1148 AC3): when a PR is
 * already green and mergeable, the reconciler should surface a structured
 * merge-ready signal instead of asking the operator.
 */
export function evaluatePRMergeReadiness(pr: GitHubPRState): PRMergeReadiness {
  const mergeable = pr.status === 'open' && pr.mergeable === 'MERGEABLE';
  const pendingChecks = pr.checks
    .filter((check) => check.status !== 'completed')
    .map((check) => check.name);
  const failingChecks = pr.checks
    .filter((check) => check.conclusion === 'failure' || check.conclusion === 'timed_out')
    .map((check) => check.name);
  const checksGreen = pendingChecks.length === 0 && failingChecks.length === 0;
  return { mergeable, checksGreen, pendingChecks, failingChecks };
}

/** True when {@link evaluatePRMergeReadiness} reports both a mergeable PR and green checks. */
export function isPRGreenAndMergeable(pr: GitHubPRState): boolean {
  const readiness = evaluatePRMergeReadiness(pr);
  return readiness.mergeable && readiness.checksGreen;
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

    const { stdout: json } = await execGh([
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
    const { stdout: json } = await execGh([
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

// --- Repo-health batched fetcher --------------------------------------------

/**
 * Fetch open-issue / open-PR counts and a short list of pending PRs for a
 * batch of repos in a single GraphQL request. Returns a Map keyed by
 * `github.com/owner/repo` project id.
 *
 * Whole-batch failures (transport, timeout, top-level GraphQL error) return
 * `null` so the caller can preserve its previous cache. Rate-limit failures
 * return a typed diagnostic with the backoff window. Per-repo NOT_FOUND
 * still surfaces as the repo being omitted from the map.
 */
export async function fetchBatchRepoHealth(
  repos: ReadonlyArray<{ projectId: string; owner: string; repo: string }>,
  login: string | null,
): Promise<GitHubRepoHealthFetchResult<ProjectRepoHealth>> {
  if (repos.length === 0) return new Map();
  const tickAt = new Date().toISOString();

  // Build aliased GraphQL query. Aliases are deterministic so we can decode
  // by index without parsing the query back. When a login is known, a parallel
  // per-repo `s${i}: search(...)` field returns the user's open PRs in that
  // repo (review-requested, assigned, or authored) — the "needs your attention"
  // list. When login is null, the search aliases are omitted and the list is
  // empty per repo.
  const aliasParts: string[] = [];
  repos.forEach(({ owner, repo }, i) => {
    aliasParts.push(
      `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
        nameWithOwner
        url
        openIssues: issues(states: OPEN) { totalCount }
        openPRs: pullRequests(states: OPEN) { totalCount }
      }`,
    );
    if (login) {
      // `involves:USER` matches PRs where the user is author, assignee,
      // reviewer, or commenter — covers every reason the PR might need their
      // attention in one qualifier (GitHub search does not support OR
      // between separate qualifiers).
      const q = `is:pr is:open repo:${owner}/${repo} involves:${login}`;
      aliasParts.push(
        `s${i}: search(query: ${JSON.stringify(q)}, type: ISSUE, first: 5) {
          nodes { ... on PullRequest { number title url } }
        }`,
      );
    }
  });
  const query = `{
${aliasParts.join('\n')}
}`;

  let json: string;
  try {
    const body = JSON.stringify({ query });
    json = await spawnGhWithStdin(['api', 'graphql', '--include', '--input', '-'], body, 30000);
  } catch (err) {
    const rateLimit = classifyGitHubRateLimit(err) ?? classifyGitHubRateLimit(ghErrorStdout(err));
    if (rateLimit) {
      console.warn(`[github] fetchBatchRepoHealth: rate limited: ${rateLimit.message}`);
      return rateLimit;
    }
    console.warn('[github] fetchBatchRepoHealth: gh api graphql failed:', err instanceof Error ? err.message : String(err));
    return null;
  }

  let parsed: {
    data?: Record<string, GhRepoHealthNode | GhSearchNode | null> | null;
    errors?: Array<{ type?: string; message?: string; path?: unknown[] }>;
  };
  let headerRateLimit: GitHubRateLimit | null = null;
  try {
    const response = splitGhApiOutput(json);
    parsed = JSON.parse(response.body);
    headerRateLimit = classifyGitHubRateLimit(response.headers);
  } catch (err) {
    const rateLimit = classifyGitHubRateLimit(json);
    if (rateLimit) {
      console.warn(`[github] fetchBatchRepoHealth: rate limited: ${rateLimit.message}`);
      return rateLimit;
    }
    console.warn('[github] fetchBatchRepoHealth: bad JSON response:', err instanceof Error ? err.message : String(err));
    return null;
  }

  const rateLimit = classifyGitHubRateLimit(parsed);
  if (rateLimit) {
    console.warn(`[github] fetchBatchRepoHealth: rate limited: ${rateLimit.message}`);
    return rateLimit;
  }

  // Top-level failure: data missing or all-null with only errors.
  if (!parsed.data) {
    if (headerRateLimit) {
      console.warn(`[github] fetchBatchRepoHealth: rate limited: ${headerRateLimit.message}`);
      return headerRateLimit;
    }
    const errMsg = parsed.errors?.[0]?.message ?? 'unknown';
    console.warn(`[github] fetchBatchRepoHealth: top-level GraphQL error: ${errMsg}`);
    return null;
  }

  const result = new Map<string, ProjectRepoHealth>();
  repos.forEach(({ projectId, owner, repo }, i) => {
    const node = parsed.data?.[`r${i}`] as GhRepoHealthNode | null | undefined;
    if (!node) return; // per-repo NOT_FOUND or null — omit from result

    const expectedFullName = `${owner}/${repo}`.toLowerCase();
    const returnedFullName = (node.nameWithOwner ?? '').toLowerCase();
    if (returnedFullName && returnedFullName !== expectedFullName) {
      console.log(`[github] repo rename detected: ${expectedFullName} → ${returnedFullName}`);
    }

    const safeUrl = projectRepoUrl(projectId);
    if (!safeUrl) return; // belt-and-suspenders; scanner pre-validates

    const pendingPrs: ProjectRepoHealth['pendingReviewPrs'] = [];
    const searchNode = parsed.data?.[`s${i}`] as GhSearchNode | undefined;
    for (const pr of searchNode?.nodes ?? []) {
      if (!pr || typeof pr.number !== 'number' || !Number.isFinite(pr.number)) continue;
      const title = typeof pr.title === 'string' ? pr.title : '';
      const url = typeof pr.url === 'string' ? pr.url : '';
      if (!isSafePullRequestUrl(url, projectId)) continue;
      pendingPrs.push({ number: pr.number, title, url });
      if (pendingPrs.length >= 5) break;
    }

    const openIssues = Number(node.openIssues?.totalCount);
    const openPullRequests = Number(node.openPRs?.totalCount);
    result.set(projectId, {
      openIssues: Number.isFinite(openIssues) ? openIssues : 0,
      openPullRequests: Number.isFinite(openPullRequests) ? openPullRequests : 0,
      pendingReviewPrs: pendingPrs,
      repoUrl: safeUrl,
      lastFetchedAt: tickAt,
    });
  });
  if (headerRateLimit) {
    console.warn(`[github] fetchBatchRepoHealth: rate limited after successful fetch: ${headerRateLimit.message}`);
    return { repoHealth: result, rateLimit: headerRateLimit };
  }
  return result;
}

function splitGhApiOutput(stdout: string): { headers: string; body: string } {
  const crlfIndex = stdout.lastIndexOf('\r\n\r\n');
  if (crlfIndex >= 0) {
    return {
      headers: stdout.slice(0, crlfIndex),
      body: stdout.slice(crlfIndex + 4),
    };
  }

  const lfIndex = stdout.lastIndexOf('\n\n');
  if (lfIndex >= 0) {
    return {
      headers: stdout.slice(0, lfIndex),
      body: stdout.slice(lfIndex + 2),
    };
  }

  return { headers: '', body: stdout };
}

async function execGh(
  args: string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return withGhRetry(args, () => execFile('gh', args, options));
}

/**
 * Spawn `gh` with the given args and pipe `stdinData` into its stdin. Returns
 * stdout. Avoids ARG_MAX issues at large query sizes. Rejects on non-zero exit
 * or timeout.
 */
async function spawnGhWithStdin(args: string[], stdinData: string, timeoutMs: number): Promise<string> {
  return withGhRetry(args, () => spawnGhWithStdinOnce(args, stdinData, timeoutMs));
}

async function withGhRetry<T>(args: string[], operation: () => Promise<T>): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= DEFAULT_GH_MAX_ATTEMPTS || !isTransientGhError(err)) throw err;
      console.warn('[github] transient gh CLI failure; retrying', {
        args,
        attempt,
        maxAttempts: DEFAULT_GH_MAX_ATTEMPTS,
        error: err instanceof Error ? err.message : String(err),
      });
      await delay(DEFAULT_GH_RETRY_DELAYS_MS[attempt - 1] ?? DEFAULT_GH_RETRY_DELAYS_MS[DEFAULT_GH_RETRY_DELAYS_MS.length - 1]!);
      attempt++;
    }
  }
}

function spawnGhWithStdinOnce(args: string[], stdinData: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err: Error | null, out: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`gh ${args.join(' ')} timed out after ${timeoutMs}ms`), '');
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish(err, ''));
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout);
      else finish(Object.assign(new Error(`gh exited ${code}: ${stderr.trim() || '(no stderr)'}`), { stdout, stderr }), '');
    });
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

function isTransientGhError(err: unknown): boolean {
  if (classifyGitHubRateLimit(err)) return false;
  const error = err as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown; stderr?: unknown } | null;
  const code = typeof error?.code === 'string' ? error.code : '';
  const signal = typeof error?.signal === 'string' ? error.signal : '';
  const message = [
    typeof error?.message === 'string' ? error.message : '',
    typeof error?.stderr === 'string' ? error.stderr : '',
  ].join('\n');
  return code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || code === 'ENOTFOUND'
    || (error?.killed === true && signal === 'SIGTERM')
    || /timed out|timeout|network|connection reset|connection refused|TLS|HTTP 5\d\d|stream error/i.test(message);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GhRepoHealthNode {
  nameWithOwner?: string;
  url?: string;
  openIssues?: { totalCount?: number };
  openPRs?: { totalCount?: number };
}

interface GhSearchNode {
  nodes?: Array<{
    number?: number;
    title?: string;
    url?: string;
  } | null>;
}

export function classifyGitHubRateLimit(value: unknown): GitHubRateLimit | null {
  const messages = collectRateLimitMessages(value);
  const explicit = messages.find((message) => isRateLimitMessage(message));
  const zeroRemaining = messages.find((message) => /x-ratelimit-remaining\s*:\s*0/i.test(message));
  const message = explicit ?? zeroRemaining;
  if (!message) return null;

  return {
    kind: 'rate-limited',
    retryAfterMs: parseRetryAfterMs(messages) ?? DEFAULT_RATE_LIMIT_RETRY_AFTER_MS,
    message: message.trim(),
  };
}

function collectRateLimitMessages(value: unknown): string[] {
  const messages: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      const lines = current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      messages.push(...(lines.length > 1 ? lines : [current]));
      return;
    }
    if (current instanceof Error) {
      messages.push(current.message);
      if ('stderr' in current && typeof current.stderr === 'string') {
        messages.push(current.stderr);
      }
      if ('stdout' in current && typeof current.stdout === 'string') {
        visit(current.stdout);
      }
      return;
    }
    if (!isRecord(current)) return;

    const type = current.type;
    const message = current.message;
    if (typeof type === 'string' && type.toUpperCase() === 'RATE_LIMITED') {
      messages.push(typeof message === 'string' ? `RATE_LIMITED: ${message}` : 'RATE_LIMITED');
    } else if (typeof message === 'string') {
      messages.push(message);
    }

    const errors = current.errors;
    if (Array.isArray(errors)) {
      for (const err of errors) visit(err);
    }

    const headers = current.headers;
    if (isRecord(headers)) {
      for (const [key, headerValue] of Object.entries(headers)) {
        if (typeof headerValue === 'string' || typeof headerValue === 'number') {
          messages.push(`${key}: ${headerValue}`);
        }
      }
    }
  };

  visit(value);
  return messages;
}

function ghErrorStdout(err: unknown): string | null {
  return isRecord(err) && typeof err.stdout === 'string' ? err.stdout : null;
}

function isRateLimitMessage(message: string): boolean {
  return /\bRATE_LIMITED\b/i.test(message)
    || /rate limit/i.test(message)
    || /rate-limit/i.test(message)
    || /rate limited/i.test(message)
    || /secondary limit/i.test(message);
}

function parseRetryAfterMs(messages: string[]): number | null {
  for (const message of messages) {
    const retryAfter = message.match(/retry-after\s*:\s*(\d+)/i)
      ?? message.match(/retry_after["'\s:=]+(\d+)/i)
      ?? message.match(/retry after\s+(\d+)\s*(?:seconds?|s)?/i);
    if (!retryAfter) continue;
    const seconds = Number(retryAfter[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }

  for (const message of messages) {
    const reset = message.match(/x-ratelimit-reset\s*:\s*(\d+)/i);
    if (!reset) continue;
    const epochSeconds = Number(reset[1]);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      return Math.max(0, (epochSeconds * 1000) - Date.now());
    }
  }
  return null;
}
