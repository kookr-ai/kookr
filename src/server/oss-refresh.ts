import { readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  OssAttemptStore,
  IssueCheckError,
  LinkedIssueState,
  ContributionAttempt,
} from '../core/oss-attempt-store.js';
import { isExternalRepo } from '../core/oss-attempt-store.js';

const execFileAsync = promisify(execFile);

/**
 * Bounded budget for `gh` subprocess calls per refresh run. Covers list +
 * detail (issue-state + closing-detail) calls. Was 30 before the zombie-PR
 * detection feature; bumped to 60 to cover the first-run burst of up-to-17
 * linked-issue fetches (see rfc-oss-zombie-pr-detection §4.6). Upper bound
 * documented at ~40 repos / ~45 linked-open PRs in NFM-1.
 */
const GH_CALL_BUDGET = 60;
const DEFAULT_PR_LIST_LIMIT = 100;
const MAX_CLOSING_COMMENT_CHARS = 500;

/**
 * Shape of ~/.kookr/oss-repos.json (see rfc-oss-repo-registry.md).
 * Only the fields we consume are typed.
 */
interface OssRegistryFile {
  version?: number;
  repos?: Record<string, { status?: string } | undefined>;
}

export interface RefreshResult {
  ok: boolean;
  reposProcessed: number;
  reposTotal: number;
  ghCalls: number;
  startedAt: string;
  finishedAt: string;
  /** List + closing-detail failures. Blocks `lastRefreshAt` advancement. */
  errors: Array<{ repo: string; message: string }>;
  /**
   * PR-granular issue-state fetch failures. Does NOT block `lastRefreshAt`
   * advancement — a flaky day on the issue-state endpoint must not kill the
   * freshness banner. Surfaced to the user via the dashboard warning banner
   * sourced from `store.lastRefreshIssueCheckErrors`.
   */
  issueCheckErrors: IssueCheckError[];
  /** Count of issue-state fetches actually dispatched (includes errored). */
  issueChecksPerformed: number;
  /** Count of issue-state fetches skipped because budget was exhausted. */
  issueChecksSkipped: number;
  truncated: string[]; // repos whose gh pr list returned exactly the limit
  partial: boolean;
  fatal?: string;
}

export interface RefreshDeps {
  store: OssAttemptStore;
  kookrDir?: string;
  /** Override for tests — if unset, uses execFile('gh', ...). */
  runGh?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Override for tests — reads the registry file from this path. */
  registryPath?: string;
}

interface GhPrListItem {
  number: number;
  title: string;
  url: string;
  state: string; // "OPEN" | "CLOSED" | "MERGED"
  createdAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  updatedAt?: string;
  /**
   * PR body text. Requested in the `gh pr list --json` field set so the
   * refresher can parse `Fixes/Closes/Resolves #N` on every observation
   * without a per-PR `gh pr view` call. Verified to work on gh 2.4.0, the
   * stability floor for this feature.
   */
  body?: string;
}

interface GhPrDetail {
  closedAt?: string | null;
  comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
  /**
   * PR body text. We parse "Fixes/Closes/Resolves #NNN" from here instead of
   * using the `closingIssuesReferences` JSON field, because `body` is supported
   * by every gh CLI version while `closingIssuesReferences` was added later and
   * errors with "Unknown JSON field" on older installs.
   */
  body?: string;
}

/**
 * Shape of `gh api repos/{owner}/{repo}/issues/{N}` — parsed in Node
 * defensively, not via `gh --jq`, because `closed_by` can be `null` (manual
 * close) or `{pull_request: null}` (PR reference missing), and a jq expression
 * traversing `.closed_by.pull_request.number` would crash on those.
 */
interface GhIssueDetail {
  state?: string;
  closed_at?: string | null;
  closed_by?: { pull_request?: { number?: number } | null } | null;
}

const ISSUE_LINK_RE = /\b(?:fixes|closes|resolves)\s+#(\d+)\b/gi;

/**
 * Extract every linked issue number from a PR body, in order, deduplicated.
 * Matches GitHub's closing-keyword syntax: "Fixes #42", "Closes #42",
 * "Resolves #42" (case-insensitive). Returns an empty array on null/empty.
 *
 * The zombie-PR detection path iterates this list and short-circuits on the
 * first result that is `closed` by a different PR. The single scout-dedup
 * call site in the `newlyClosed` block takes `[0] ?? null` for the same
 * behavior the old singular function provided.
 */
export function extractAllIssueNumbersFromBody(body?: string | null): number[] {
  if (!body) return [];
  const numbers: number[] = [];
  for (const m of body.matchAll(ISSUE_LINK_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && !numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

/**
 * On-demand refresh: runs `gh pr list` per external repo in the registry,
 * reconciles state with the store, optionally fetches closing details for
 * newly-closed PRs. Bounded by a hard call budget and serialized by an
 * in-process promise mutex to prevent concurrent runs.
 */
export class OssRefresher {
  private inflight: Promise<RefreshResult> | null = null;

  constructor(private deps: RefreshDeps) {}

  /**
   * Run a refresh. Concurrent calls share the same in-flight promise — the
   * second caller awaits the first one's result (R6).
   */
  async refresh(): Promise<RefreshResult> {
    if (this.inflight) return this.inflight;
    const promise = this.runOnce().finally(() => {
      this.inflight = null;
    });
    this.inflight = promise;
    return promise;
  }

  private async runOnce(): Promise<RefreshResult> {
    const startedAt = new Date().toISOString();
    const errors: Array<{ repo: string; message: string }> = [];
    const issueCheckErrors: IssueCheckError[] = [];
    const truncated: string[] = [];
    let ghCalls = 0;
    let issueChecksPerformed = 0;
    let issueChecksSkipped = 0;

    const registryPath =
      this.deps.registryPath ?? join(this.deps.kookrDir ?? join(homedir(), '.kookr'), 'oss-repos.json');
    const externalRepos = await this.loadExternalRepos(registryPath);

    if (externalRepos.length === 0) {
      // Zero-registry is a no-op run, not a verified-clean one. Leave any
      // prior `lastRefreshIssueCheckErrors` intact — they represent the last
      // time we actually observed something.
      const finishedAt = new Date().toISOString();
      this.deps.store.setLastRefreshAt(finishedAt);
      return {
        ok: true,
        reposProcessed: 0,
        reposTotal: 0,
        ghCalls: 0,
        startedAt,
        finishedAt,
        errors,
        issueCheckErrors,
        issueChecksPerformed,
        issueChecksSkipped,
        truncated,
        partial: false,
      };
    }

    let processed = 0;

    for (const repo of externalRepos) {
      try {
        // Always list every repo — no top-of-loop budget break. At current
        // scale (11 repos) this is ~11 calls, well within a 60-call budget.
        // Detail calls (issue-state + closing-detail) are throttled per-PR.
        const listResult = await this.runGh([
          'pr',
          'list',
          '--repo',
          repo,
          '--author',
          '@me',
          '--state',
          'all',
          '--limit',
          String(DEFAULT_PR_LIST_LIMIT),
          '--json',
          'number,title,url,state,createdAt,mergedAt,closedAt,updatedAt,body',
        ]);
        ghCalls++;

        let prs: GhPrListItem[] = [];
        try {
          prs = JSON.parse(listResult.stdout) as GhPrListItem[];
        } catch (e) {
          errors.push({ repo, message: `invalid JSON from gh pr list: ${(e as Error).message}` });
          processed++;
          continue;
        }

        if (prs.length === DEFAULT_PR_LIST_LIMIT) {
          truncated.push(repo);
        }

        for (const pr of prs) {
          const normalizedState = this.normalizeState(pr.state);
          const prevAttempt = this.deps.store
            .getByRepo(repo)
            .find((a) => a.prNumber === pr.number);
          const wasClosedOrMerged =
            prevAttempt?.state === 'closed' || prevAttempt?.state === 'merged';

          // Body-parse every observation so both the scout dedup index and
          // the zombie detection path see the linked issue numbers. Backfill
          // `issueNumber` only when null to preserve the stable index key.
          const linkedNumbers = extractAllIssueNumbersFromBody(pr.body);
          const backfillIssueNumber =
            linkedNumbers.length > 0 && prevAttempt?.issueNumber == null
              ? linkedNumbers[0]
              : null;

          this.deps.store.upsertFromRefresh({
            repo,
            prNumber: pr.number,
            prUrl: pr.url,
            prTitle: pr.title,
            state: normalizedState,
            source: 'refresh_poll',
            at: pr.updatedAt ?? pr.createdAt,
            issueNumber: backfillIssueNumber,
          });

          // Zombie-PR detection: for open PRs with at least one linked issue,
          // verify each linked issue's state against GitHub and store the
          // result. Short-circuits on the first closed-by-different-PR match.
          // Skip entirely if the cached linkedIssue is already a `closed`
          // entry matching one of the current linked numbers — terminal cache.
          if (normalizedState === 'pr_open' && linkedNumbers.length > 0) {
            const cached = prevAttempt?.linkedIssue ?? null;
            const cachedIsTerminal =
              cached?.state === 'closed' && linkedNumbers.includes(cached.number);

            if (!cachedIsTerminal) {
              const result = await this.checkLinkedIssueState(
                repo,
                pr.number,
                linkedNumbers,
                cached,
                ghCalls,
                issueCheckErrors,
              );
              ghCalls = result.ghCalls;
              issueChecksPerformed += result.performed;
              issueChecksSkipped += result.skipped;
              this.deps.store.attachLinkedIssue(repo, pr.number, result.linkedIssue);
            }
          }

          // Fetch closing details for PRs that JUST transitioned to closed
          // (not merged — merges are celebratory, no review-comment context needed).
          // Also retroactively patch issueNumber from the body parse.
          const newlyClosed =
            normalizedState === 'closed' && !wasClosedOrMerged && ghCalls < GH_CALL_BUDGET;
          if (newlyClosed) {
            try {
              const detailResult = await this.runGh([
                'pr',
                'view',
                pr.url,
                '--json',
                'closedAt,comments,body',
              ]);
              ghCalls++;
              const detail = JSON.parse(detailResult.stdout) as GhPrDetail;
              const lastComment = detail.comments?.[detail.comments.length - 1];
              this.deps.store.attachClosing({
                repo,
                prNumber: pr.number,
                closedAt: detail.closedAt ?? pr.closedAt ?? new Date().toISOString(),
                closerLogin: lastComment?.author?.login ?? null,
                closingComment: (lastComment?.body ?? '').slice(0, MAX_CLOSING_COMMENT_CHARS),
                issueNumber: extractAllIssueNumbersFromBody(detail.body)[0] ?? null,
              });
            } catch (e) {
              errors.push({
                repo,
                message: `gh pr view ${pr.url} failed: ${(e as Error).message}`,
              });
            }
          }
        }

        processed++;
      } catch (e) {
        errors.push({ repo, message: `gh pr list failed: ${(e as Error).message}` });
      } finally {
        // Per-repo save in `finally` protects partial-progress durability on
        // SIGINT: every repo we've already finished upserting lands on disk
        // before the next repo starts. The save itself is wrapped in its own
        // try/catch so a disk-full / atomic-rename failure doesn't propagate
        // out of the finally and abort every subsequent repo.
        try {
          await this.deps.store.save();
        } catch (saveErr) {
          console.warn(
            `[oss-refresh] save failed for repo ${repo}: ${(saveErr as Error).message}`,
          );
        }
      }
    }

    // Record the issue-check errors from this run so the dashboard's warning
    // banner can source them via the normal snapshot path — regardless of
    // whether the refresh was triggered by the manual button, the startup
    // refresh, or a future timer.
    this.deps.store.setLastRefreshIssueCheckErrors(issueCheckErrors);

    const finishedAt = new Date().toISOString();
    // Only bump lastRefreshAt when ALL repos were processed with zero LIST
    // errors (R3/NFM-4 safety). Issue-check errors do NOT block advancement.
    if (processed === externalRepos.length && errors.length === 0) {
      this.deps.store.setLastRefreshAt(finishedAt);
    }

    // One final save to persist setLastRefreshAt / setLastRefreshIssueCheckErrors.
    try {
      await this.deps.store.save();
    } catch (e) {
      return {
        ok: false,
        reposProcessed: processed,
        reposTotal: externalRepos.length,
        ghCalls,
        startedAt,
        finishedAt: new Date().toISOString(),
        errors,
        issueCheckErrors,
        issueChecksPerformed,
        issueChecksSkipped,
        truncated,
        partial: processed < externalRepos.length,
        fatal: `save failed: ${(e as Error).message}`,
      };
    }

    // Operator-visible summary log line (NFM-6).
    const staleCount = this.countStale();
    const errorCount = issueCheckErrors.length;
    console.log(
      `[oss-refresh] ${processed} repos, ${issueChecksPerformed} issue checks ` +
        `(${errorCount} errors, ${issueChecksSkipped} skipped), ${staleCount} stale`,
    );

    return {
      ok: errors.length === 0,
      reposProcessed: processed,
      reposTotal: externalRepos.length,
      ghCalls,
      startedAt,
      finishedAt,
      errors,
      issueCheckErrors,
      issueChecksPerformed,
      issueChecksSkipped,
      truncated,
      partial: processed < externalRepos.length,
    };
  }

  /**
   * Iterate linked issue numbers in order, short-circuiting on the first
   * closed-by-different-PR match. Each `gh api` call is wrapped in its own
   * try/catch: a transient error pushes to `issueCheckErrors` and continues
   * to the next number instead of aborting the PR's iteration.
   *
   * The returned `linkedIssue` is the value to persist:
   *   - a closed-by-different-PR match (zombie), if any;
   *   - otherwise the first successful `open` result;
   *   - otherwise `prevLinkedIssue` — preserving the previous cache when
   *     every attempt errored out. Callers always write the returned value;
   *     there is no "do not write" sentinel.
   */
  private async checkLinkedIssueState(
    repo: string,
    prNumber: number,
    linkedNumbers: number[],
    prevLinkedIssue: LinkedIssueState | null,
    ghCallsAtStart: number,
    issueCheckErrors: IssueCheckError[],
  ): Promise<{
    linkedIssue: LinkedIssueState | null;
    ghCalls: number;
    performed: number;
    skipped: number;
  }> {
    let ghCalls = ghCallsAtStart;
    let performed = 0;
    let skipped = 0;
    let firstOpen: LinkedIssueState | null = null;
    let anySuccess = false;

    for (const issueNumber of linkedNumbers) {
      if (ghCalls >= GH_CALL_BUDGET) {
        skipped++;
        continue;
      }
      let detail: LinkedIssueState;
      try {
        detail = await this.fetchLinkedIssueState(repo, issueNumber);
        ghCalls++;
        performed++;
        anySuccess = true;
      } catch (e) {
        issueCheckErrors.push({
          repo,
          prNumber,
          message: `issue-state #${issueNumber} failed: ${(e as Error).message}`,
        });
        ghCalls++;
        performed++;
        continue;
      }

      // Zombie match: any closed result that is not the PR closing itself.
      // `closingPrNumber` may be null (manual/commit-based close) — still a
      // zombie signal; the frontend's `isStale` applies the self-close guard
      // via `closingPrNumber !== attempt.prNumber`. Short-circuit so we
      // don't burn budget on sibling open issues.
      if (
        detail.state === 'closed' &&
        !(detail.closingPrNumber != null && detail.closingPrNumber === prNumber)
      ) {
        return { linkedIssue: detail, ghCalls, performed, skipped };
      }

      if (detail.state === 'open' && firstOpen == null) {
        firstOpen = detail;
      }
    }

    // No zombie match. If we successfully fetched any issue, the first open
    // result is our new cache. Otherwise (every attempt errored), preserve
    // the previous cache — we have no fresh signal to overwrite it with.
    const next = anySuccess ? firstOpen : prevLinkedIssue;
    return { linkedIssue: next, ghCalls, performed, skipped };
  }

  /**
   * Fetch verified issue state via `gh api repos/{owner}/{repo}/issues/{N}`.
   * Parses the response in Node with defensive optional chaining rather than
   * `gh --jq`, because a jq expression traversing `.closed_by.pull_request.number`
   * crashes when `closed_by` or `pull_request` is `null` (manually-closed
   * issues). Handles four `closed_by` shapes: `null`, `{}`, `{pull_request: null}`,
   * and the normal `{pull_request: {number}}` case. Missing / unknown `state`
   * defaults to `'open'` (the GitHub live default).
   */
  private async fetchLinkedIssueState(
    repo: string,
    issueNumber: number,
  ): Promise<LinkedIssueState> {
    const out = await this.runGh(['api', `repos/${repo}/issues/${issueNumber}`]);
    const detail = JSON.parse(out.stdout) as GhIssueDetail;
    const rawState = (detail.state ?? 'open').toLowerCase();
    const state: 'open' | 'closed' = rawState === 'closed' ? 'closed' : 'open';
    return {
      number: issueNumber,
      state,
      closedAt: state === 'closed' ? (detail.closed_at ?? null) : null,
      closingPrNumber: detail.closed_by?.pull_request?.number ?? null,
      verifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Count zombie PRs in the store. Used for the NFM-6 summary log line.
   * Pure read from snapshot — no mutation.
   */
  private countStale(): number {
    const attempts = this.deps.store.getAllAttempts();
    let count = 0;
    for (const a of attempts) {
      if (a.state !== 'pr_open') continue;
      const li = a.linkedIssue ?? null;
      if (!li || li.state !== 'closed') continue;
      if (li.closingPrNumber != null && li.closingPrNumber === a.prNumber) continue;
      count++;
    }
    return count;
  }

  private normalizeState(ghState: string): 'pr_open' | 'merged' | 'closed' {
    const s = ghState.toUpperCase();
    if (s === 'MERGED') return 'merged';
    if (s === 'CLOSED') return 'closed';
    return 'pr_open';
  }

  private async loadExternalRepos(registryPath: string): Promise<string[]> {
    try {
      await access(registryPath);
    } catch {
      return [];
    }
    let raw: string;
    try {
      raw = await readFile(registryPath, 'utf-8');
    } catch {
      return [];
    }
    let parsed: OssRegistryFile;
    try {
      parsed = JSON.parse(raw) as OssRegistryFile;
    } catch {
      return [];
    }
    const repos = parsed.repos ?? {};
    const external: string[] = [];
    const ownNamespaces = this.deps.store.getOwnNamespaces();
    for (const [repo, meta] of Object.entries(repos)) {
      if (!meta) continue;
      if (meta.status && meta.status !== 'active') continue;
      if (!isExternalRepo(repo, ownNamespaces)) continue;
      external.push(repo);
    }
    return external.sort();
  }

  private async runGh(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (this.deps.runGh) return this.deps.runGh(args);
    try {
      const result = await execFileAsync('gh', args, {
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env },
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (e) {
      throw new Error((e as Error).message);
    }
  }
}
