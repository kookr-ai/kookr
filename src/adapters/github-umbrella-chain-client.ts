import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isValidIsoTimestamp } from '../core/iso-timestamp.js';
import { PHASE_LEDGER_FENCE } from '../core/phase-ledger-codec.js';

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

/**
 * Bounded retry for a transient `gh` read. Defaults mirror the sibling
 * `github-fetcher` helper (3 attempts; 1s then 3s back-off). `sleep` is
 * injectable so tests exercise the retry path without incurring real delays.
 */
export interface GhRetryOptions {
  maxAttempts?: number;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_GH_MAX_ATTEMPTS = 3;
const DEFAULT_GH_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

/**
 * A transient `gh` failure worth retrying: a 5xx response or a network-level
 * fault. Rate limits (surfaced as HTTP 403/429, never 5xx) are deliberately
 * excluded so a throttle is not hammered.
 *
 * The text match runs against `stderr` — gh's own error output — only, never
 * the `promisify(execFile)` `.message`. That message is `Command failed: <full
 * command line>\n<stderr>`, and the command line embeds the repo slug: matching
 * it would misclassify a genuine 404/403 on a repo named e.g. `acme/network-*`
 * as transient (the word "network" in the slug), retrying an error that must
 * not be retried. Network faults still surface via `code`/`signal` or gh's own
 * stderr, so dropping `.message` loses no real transient signal.
 *
 * `unexpected end of JSON input` is transient: the `listOpenIssues` poll runs
 * `gh api --paginate ... --jq`, and gh emits that on gh's stderr when a page
 * comes back truncated/empty. Retrying the poll re-reads the page instead of
 * skipping the whole project for the tick (#3073). It cannot appear in a repo
 * slug, so matching it on stderr keeps the false-positive guard above intact.
 *
 * Git ref-lock contention is transient: `refreshBase` runs `git fetch --prune`,
 * and a live ref-update race (or a lock briefly held by an in-flight fetch)
 * makes git emit `cannot lock ref …`, `unable to create '….lock': File
 * exists`, or `another git process seems to be running` on stderr. Retrying the
 * fetch clears that contention instead of skipping the whole project for the
 * tick (#3111). A genuinely stale `.lock` matches the same strings but never
 * clears; it is bounded at the same attempt cap and then surfaces the same skip
 * as before. These strings are git diagnostics, not repo slugs, so matching
 * them on stderr keeps the false-positive guard above intact.
 */
function isTransientGhError(err: unknown): boolean {
  const error = err as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown } | null;
  const code = typeof error?.code === 'string' ? error.code : '';
  const signal = typeof error?.signal === 'string' ? error.signal : '';
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  return code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || code === 'ENOTFOUND'
    || (error?.killed === true && signal === 'SIGTERM')
    || /timed out|timeout|network|connection reset|connection refused|TLS|HTTP 5\d\d|stream error|unexpected end of json input/i.test(stderr)
    || /cannot lock ref|unable to create '.*\.lock'|another git process/i.test(stderr);
}

/** Run `operation`, retrying only transient failures within the bounded caps. */
async function withGhRetry<T>(operation: () => Promise<T>, options: GhRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_GH_MAX_ATTEMPTS;
  const delaysMs = options.delaysMs ?? DEFAULT_GH_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientGhError(err)) throw err;
      await sleep(delaysMs[attempt - 1] ?? delaysMs[delaysMs.length - 1] ?? 0);
      attempt++;
    }
  }
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
  /** Retry policy for transient `gh` reads; tests inject a no-op `sleep`. */
  retryOptions?: GhRetryOptions;
}

interface GhIssueView {
  body?: unknown;
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

function nonEmptyLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

/** Small `gh`/`git` boundary used by the advancer; all policy remains testable above it. */
export class GhUmbrellaChainClient implements UmbrellaChainRemote {
  private readonly run: typeof execFile;
  private readonly retryOptions: GhRetryOptions;

  constructor(options: GhUmbrellaChainClientOptions = {}) {
    this.run = options.exec ?? execFile;
    this.retryOptions = options.retryOptions ?? {};
  }

  async listOpenIssues(repo: string): Promise<readonly OpenIssueSummary[]> {
    const ledgerFenceStart = `\`\`\`${PHASE_LEDGER_FENCE}`;
    const { stdout } = await withGhRetry(() => this.run('gh', [
      'api',
      '--paginate',
      `repos/${repo}/issues?state=open&per_page=100`,
      '--jq',
      `.[] | select((has("pull_request") | not) and (.body | type == "string") and (.body | contains(${JSON.stringify(ledgerFenceStart)}))) | .number`,
    ], { timeout: 20_000 }), this.retryOptions);
    return nonEmptyLines(stdout).map((line): OpenIssueSummary => {
      if (!/^[1-9]\d*$/.test(line)) {
        throw new Error(`gh issue REST query returned an invalid issue number: ${line}`);
      }
      const number = Number(line);
      if (!Number.isSafeInteger(number)) {
        throw new Error(`gh issue REST query returned an invalid issue number: ${line}`);
      }
      return { number };
    });
  }

  async getIssue(repo: string, issueNumber: number): Promise<UmbrellaIssue | null> {
    const { stdout } = await withGhRetry(() => this.run('gh', [
      'api', `repos/${repo}/issues/${issueNumber}`,
    ], { timeout: 20_000 }), this.retryOptions);
    const value = json<GhIssueView>(stdout);
    if (typeof value.body !== 'string') return null;
    const commentsResult = await withGhRetry(() => this.run('gh', [
      'api',
      '--paginate',
      `repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
      '--jq',
      '.[] | select(.body | type == "string") | .body | @json',
    ], { timeout: 20_000 }), this.retryOptions);
    return {
      number: issueNumber,
      body: value.body,
      comments: nonEmptyLines(commentsResult.stdout).map((line) => {
        const body = json<unknown>(line);
        if (typeof body !== 'string') throw new Error('gh issue comments REST query returned a non-string body');
        return { body };
      }),
    };
  }

  async updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.run('gh', [
      'api', `repos/${repo}/issues/${issueNumber}`, '-X', 'PATCH', '-f', `body=${body}`,
    ], { timeout: 20_000 });
  }

  async refreshBase(repoPath: string, baseBranch: string): Promise<void> {
    // A live ref-update race (or a lock briefly held by an in-flight fetch)
    // makes this fail with a ref-lock error that clears on a retry, so retry
    // within the bounded budget instead of skipping the whole project for the
    // tick over recoverable contention (#3111). A genuinely stale `.lock` never
    // clears on its own: it exhausts the budget and then surfaces the same skip
    // as before — bounded, unchanged, no worse than the raw fetch.
    await withGhRetry(
      () => this.run('git', ['-C', repoPath, 'fetch', '--prune', 'origin', baseBranch], { timeout: 30_000 }),
      this.retryOptions,
    );
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
