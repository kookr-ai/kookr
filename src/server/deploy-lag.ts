// src/server/deploy-lag.ts — deploy-lag detector core (issue #1594).
//
// The system's terminal action everywhere is "merge PR" — nothing verifies the
// fix is actually LIVE. `prod:update` is explicit and operator-triggered (repo
// policy, and it stays that way), so merged commits can sit undeployed
// indefinitely with no signal. lucy #1653 was exactly this: prod kept serving a
// deprecated model after the two fixes for it had merged ("deploy lag at
// GIT_SHA 2437099") and nothing alerted on the gap.
//
// This module holds the *pure* lag-evaluation logic plus the thin default
// resolvers that read the running SHA of each prod and diff it against
// `origin/main`. The stateful tick that runs it on a schedule and files/updates
// a single operational-alert artifact lives in `deploy-lag-detector.ts`.
//
// It only ALERTS. It never triggers a deploy — `prod:update` stays
// operator-triggered (issue #1594 AC + umbrella #1551 policy).
//
// The alert-artifact machinery (streak dedup, edge-triggered fire/recover) is
// reused wholesale from the smoke suite (`prod-smoke.ts`): each monitored prod
// maps to one `CheckResult`, so a persisting lag updates ONE artifact instead
// of filing a fresh one every tick (AC5), exactly as the hourly smoke tick does.

import {
  type CheckResult,
  formatDuration,
} from './prod-smoke.js';

/** True for a string that looks like an abbreviated-or-full git object id (7–40 hex). */
export function gitShaLike(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

// ---------------------------------------------------------------------------
// Model.
// ---------------------------------------------------------------------------

/** One merged-but-not-deployed commit, named in the alert (AC1/AC2). */
export interface PendingCommit {
  /** Abbreviated SHA (`git log %h`). */
  shortSha: string;
  /** Committer timestamp in epoch ms (`git log %ct`, seconds → ms). */
  committedAtMs: number;
  /** First line of the commit message (`git log %s`). */
  subject: string;
}

export type DeployLagStatus =
  /** Deployed SHA == origin/main — nothing pending. */
  | 'up-to-date'
  /** Behind origin/main, but the oldest undeployed commit is younger than the threshold. */
  | 'within-threshold'
  /** Behind origin/main and the oldest undeployed commit is past the threshold — ALERT. */
  | 'lagging'
  /** Could not resolve one of the SHAs (network/git failure) — never alerts on its own. */
  | 'unknown';

export interface DeployLagTargetResult {
  /** Prod identity, e.g. `kookr` or `lucy`. */
  target: string;
  status: DeployLagStatus;
  /** False ONLY when `status === 'lagging'`; everything else is a non-alert. */
  ok: boolean;
  deployedSha: string | null;
  mainSha: string | null;
  /** Commits on origin/main that are not in the deployed SHA (newest first). */
  pendingCommits: PendingCommit[];
  /** Age of the OLDEST undeployed commit in ms, or null when up-to-date/unknown. */
  lagMs: number | null;
  /** Operator-facing one-liner; names the pending commits when lagging. */
  detail: string;
}

/** Raw resolver output — the I/O layer fills this in; {@link evaluateDeployLag} judges it. */
export interface DeployLagTargetSnapshot {
  target: string;
  /** Running/deployed SHA (full, normalized), or null when it could not be resolved. */
  deployedSha: string | null;
  /** `origin/main` SHA (full), or null when it could not be resolved. */
  mainSha: string | null;
  /** Commits in `deployedSha..mainSha` (newest first). Empty when up-to-date. */
  pendingCommits: PendingCommit[];
  /** Set when a SHA is null — surfaced in the artifact so a broken detector is visible. */
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// Pure parsing helpers.
// ---------------------------------------------------------------------------

/** Field separator used in the `git log --format` string (ASCII unit separator). */
export const COMMIT_LOG_FIELD_SEP = '\x1f';
/** `git log --format` template that {@link parseCommitLog} understands. */
export const COMMIT_LOG_FORMAT = `%h${COMMIT_LOG_FIELD_SEP}%ct${COMMIT_LOG_FIELD_SEP}%s`;

/**
 * Parse `git log --format=COMMIT_LOG_FORMAT` output into {@link PendingCommit}s.
 * Malformed or empty lines are skipped; a commit with an unparseable timestamp
 * is dropped rather than poisoning the oldest-commit age with NaN.
 */
export function parseCommitLog(stdout: string): PendingCommit[] {
  const commits: PendingCommit[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [shortSha, ctSeconds, ...subjectParts] = line.split(COMMIT_LOG_FIELD_SEP);
    if (!shortSha || ctSeconds === undefined) continue;
    const seconds = Number(ctSeconds);
    if (!Number.isFinite(seconds)) continue;
    commits.push({
      shortSha,
      committedAtMs: seconds * 1000,
      subject: subjectParts.join(COMMIT_LOG_FIELD_SEP),
    });
  }
  return commits;
}

/** Default field names checked when pulling a git SHA out of a status payload. */
export const DEFAULT_SHA_FIELD_CANDIDATES: readonly string[] = [
  'gitSha',
  'git_sha',
  'GIT_SHA',
  'commitHash',
  'commit_hash',
  'commit',
  'sha',
  'revision',
];

/**
 * Extract a git SHA from a parsed JSON status payload. Checks each candidate
 * field at the top level and one level down under common wrappers
 * (`build`/`buildInfo`/`status`/`git`/`version`), returning the first value that
 * looks like a git SHA. Pure; returns null when nothing SHA-shaped is found.
 */
export function extractGitSha(
  payload: unknown,
  fieldCandidates: readonly string[] = DEFAULT_SHA_FIELD_CANDIDATES,
): string | null {
  const fromObject = (obj: Record<string, unknown>): string | null => {
    for (const field of fieldCandidates) {
      const value = obj[field];
      if (typeof value === 'string' && gitShaLike(value.trim())) return value.trim();
    }
    return null;
  };
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const direct = fromObject(root);
  if (direct) return direct;
  for (const wrapper of ['build', 'buildInfo', 'status', 'git', 'version']) {
    const nested = root[wrapper];
    if (nested && typeof nested === 'object') {
      const found = fromObject(nested as Record<string, unknown>);
      if (found) return found;
    }
  }
  return null;
}

/** Cap on how many pending commits are named in a single alert detail line. */
export const MAX_NAMED_PENDING_COMMITS = 10;

/** `abc1234 subject; def5678 subject; …(+N more)` — bounded so the alert stays readable. */
export function formatPendingCommits(
  commits: PendingCommit[],
  limit: number = MAX_NAMED_PENDING_COMMITS,
): string {
  if (commits.length === 0) return '(none)';
  const named = commits.slice(0, limit).map((c) => `${c.shortSha} ${c.subject}`.trim());
  const overflow = commits.length - named.length;
  const suffix = overflow > 0 ? `; …(+${overflow} more)` : '';
  return `${named.join('; ')}${suffix}`;
}

// ---------------------------------------------------------------------------
// Pure evaluation.
// ---------------------------------------------------------------------------

/**
 * Judge one prod's deploy lag. Pure — all I/O happens in the resolver that
 * produced the {@link DeployLagTargetSnapshot}.
 *
 * - Either SHA unresolved → `unknown` (ok, never alerts — a network/git blip is
 *   the detector's fault, not a deploy lag).
 * - Deployed SHA == origin/main, or nothing pending → `up-to-date` (ok).
 * - Behind, oldest undeployed commit younger than the threshold → `within-threshold`
 *   (ok — AC3: a freshly merged commit under the threshold raises no alert).
 * - Behind, oldest undeployed commit at/past the threshold → `lagging` (ALERT,
 *   naming the pending commits — AC1/AC2).
 */
export function evaluateDeployLag(input: {
  snapshot: DeployLagTargetSnapshot;
  nowMs: number;
  thresholdMs: number;
}): DeployLagTargetResult {
  const { snapshot, nowMs, thresholdMs } = input;
  const { target, deployedSha, mainSha, pendingCommits } = snapshot;
  const shortDeployed = deployedSha ? deployedSha.slice(0, 7) : '(unknown)';
  const shortMain = mainSha ? mainSha.slice(0, 7) : '(unknown)';

  if (!deployedSha || !mainSha) {
    const reason = snapshot.unavailableReason ?? 'deployed and/or origin/main SHA unavailable';
    return {
      target,
      status: 'unknown',
      ok: true,
      deployedSha,
      mainSha,
      pendingCommits: [],
      lagMs: null,
      detail: `${target}: deploy-lag indeterminate — ${reason}`,
    };
  }

  if (deployedSha === mainSha) {
    return {
      target,
      status: 'up-to-date',
      ok: true,
      deployedSha,
      mainSha,
      pendingCommits: [],
      lagMs: null,
      detail: `${target}: up to date at ${shortDeployed} (== origin/main)`,
    };
  }

  if (pendingCommits.length === 0) {
    // SHAs differ but nothing on origin/main is undeployed — the deployed SHA is
    // at or ahead of origin/main's first-parent line (a hotfix not yet on main,
    // or a diverged/force-push). Not a lag; label it honestly rather than
    // claiming equality with origin/main.
    return {
      target,
      status: 'up-to-date',
      ok: true,
      deployedSha,
      mainSha,
      pendingCommits: [],
      lagMs: null,
      detail: `${target}: no undeployed commits on origin/main (deployed ${shortDeployed}, origin/main ${shortMain})`,
    };
  }

  // Oldest pending commit's merge time (committer date on the first-parent line,
  // see diffAgainstMain's --first-parent) marks when the lag began. Reduce rather
  // than spread `Math.min(...)` so a very large range can never blow the stack.
  const oldestMs = pendingCommits.reduce((min, c) => (c.committedAtMs < min ? c.committedAtMs : min), Infinity);
  const lagMs = nowMs - oldestMs;
  const count = pendingCommits.length;

  if (lagMs < thresholdMs) {
    return {
      target,
      status: 'within-threshold',
      ok: true,
      deployedSha,
      mainSha,
      pendingCommits,
      lagMs,
      detail:
        `${target}: deployed ${shortDeployed} is ${count} commit(s) behind origin/main ${shortMain}; ` +
        `oldest undeployed commit is ${formatDuration(lagMs)} old, within the ` +
        `${formatDuration(thresholdMs)} threshold — no alert`,
    };
  }

  return {
    target,
    status: 'lagging',
    ok: false,
    deployedSha,
    mainSha,
    pendingCommits,
    lagMs,
    detail:
      `${target}: deployed ${shortDeployed} is ${count} commit(s) behind origin/main ${shortMain}; ` +
      `oldest undeployed commit is ${formatDuration(lagMs)} old, past the ${formatDuration(thresholdMs)} ` +
      `threshold. Pending: ${formatPendingCommits(pendingCommits)}`,
  };
}

/** Map an evaluated target to the smoke-suite `CheckResult` the artifact stores. */
export function targetResultToCheckResult(result: DeployLagTargetResult): CheckResult {
  return { name: `deploy-lag:${result.target}`, ok: result.ok, detail: result.detail };
}

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

export const DEFAULT_DEPLOY_LAG_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6h (issue #1594).

export interface DeployLagConfig {
  thresholdMs: number;
  /** Best-effort `git fetch origin main` before comparing, so origin/main is fresh. */
  fetchBeforeCompare: boolean;
  /** kookr repo checkout that carries the origin/main ref (the running server's cwd). */
  kookrRepoPath: string;
  /** lucy's live status surface exposing its GIT_SHA; unset ⇒ lucy is not monitored. */
  lucyStatusUrl: string | undefined;
  /** Local lucy clone carrying origin/main; unset ⇒ lucy is not monitored. */
  lucyRepoPath: string | undefined;
  /** JSON field(s) to read lucy's SHA from (falls back to the default candidates). */
  lucyShaFields: readonly string[];
}

function envHours(name: string, fallbackMs: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name]?.trim();
  if (!raw) return fallbackMs;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : fallbackMs;
}

/** Resolve the detector's tuning + target wiring from the environment. */
export function resolveDeployLagConfig(env: NodeJS.ProcessEnv, kookrRepoPath: string): DeployLagConfig {
  const shaFieldRaw = env.KOOKR_DEPLOY_LAG_LUCY_SHA_FIELD?.trim();
  return {
    thresholdMs: envHours('KOOKR_DEPLOY_LAG_THRESHOLD_HOURS', DEFAULT_DEPLOY_LAG_THRESHOLD_MS, env),
    fetchBeforeCompare: !['0', 'false', 'off', 'no'].includes(env.KOOKR_DEPLOY_LAG_FETCH?.trim().toLowerCase() ?? ''),
    kookrRepoPath: env.KOOKR_DEPLOY_LAG_KOOKR_REPO?.trim() || kookrRepoPath,
    lucyStatusUrl: env.KOOKR_DEPLOY_LAG_LUCY_STATUS_URL?.trim() || undefined,
    lucyRepoPath: env.KOOKR_DEPLOY_LAG_LUCY_REPO?.trim() || undefined,
    lucyShaFields: shaFieldRaw ? [shaFieldRaw, ...DEFAULT_SHA_FIELD_CANDIDATES] : DEFAULT_SHA_FIELD_CANDIDATES,
  };
}

// ---------------------------------------------------------------------------
// Default resolvers (thin I/O — git subprocess + one bounded HTTP GET).
// ---------------------------------------------------------------------------

/** Runs a read-only git command in `cwd`, returning trimmed stdout or null. */
export type GitReader = (cwd: string, args: string[]) => Promise<string | null>;
/** Fetches a URL and returns the parsed JSON body, or throws. */
export type StatusFetcher = (url: string) => Promise<unknown>;

/** True for a full 40-char hex object id (already normalized). */
function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Diff a resolved deployed SHA against origin/main in `repoPath` and collect the
 * pending commits. Shared by the kookr and lucy resolvers — the only difference
 * between the two prods is HOW the deployed SHA is obtained (build-info vs a
 * status HTTP surface); everything downstream (fetch, normalize, diff) is
 * identical. Read-only: only `fetch`, `rev-parse`, and `log` are ever run — the
 * detector never mutates a repo and never triggers a deploy (AC4).
 */
export async function diffAgainstMain(input: {
  target: string;
  rawDeployedSha: string | null;
  rawDeployedReason?: string;
  repoPath: string;
  git: GitReader;
  fetchBeforeCompare: boolean;
  logger?: Pick<Console, 'warn'>;
}): Promise<DeployLagTargetSnapshot> {
  const { target, rawDeployedSha, repoPath, git, fetchBeforeCompare } = input;
  const logger = input.logger ?? console;
  const unavailable = (unavailableReason: string): DeployLagTargetSnapshot => ({
    target,
    deployedSha: null,
    mainSha: null,
    pendingCommits: [],
    unavailableReason,
  });

  if (!rawDeployedSha) {
    return unavailable(input.rawDeployedReason ?? 'could not resolve the running/deployed SHA');
  }

  // Refresh origin/main so a just-merged fix is visible. Best-effort: a fetch
  // failure (offline, auth) falls back to the ref already on disk rather than
  // blinding the detector — but it is NOT silent: a persistently failing fetch
  // would otherwise pin origin/main to a stale on-disk ref and reproduce the
  // exact "nothing alerted on the gap" miss this feature exists to catch, so we
  // warn on every failed fetch (git-helpers returns null on failure).
  if (fetchBeforeCompare) {
    const fetched = await git(repoPath, ['fetch', '--quiet', 'origin', 'main']);
    if (fetched === null) {
      logger.warn(
        `[deploy-lag] git fetch origin main failed in ${repoPath}; comparing ${target} against the ` +
          `possibly-stale on-disk origin/main ref`,
      );
    }
  }

  // Normalize the deployed SHA to a full oid so the equality check and the
  // `A..B` range are exact even when the status surface reports a short SHA
  // (lucy exposes e.g. `2437099`).
  const deployedSha = isFullSha(rawDeployedSha)
    ? rawDeployedSha
    : await git(repoPath, ['rev-parse', '--verify', '--quiet', `${rawDeployedSha}^{commit}`]);
  if (!deployedSha) {
    return unavailable(`deployed SHA ${rawDeployedSha} not found in ${repoPath} (repo un-fetched or wrong clone)`);
  }

  const mainSha = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
  if (!mainSha) return unavailable(`could not resolve origin/main in ${repoPath}`);

  if (deployedSha === mainSha) {
    return { target, deployedSha, mainSha, pendingCommits: [] };
  }

  // `--first-parent` walks only origin/main's mainline, so each listed commit is
  // a merge/squash/rebase commit whose committer date is the time it LANDED on
  // main — the merge time — regardless of the repo's merge strategy. Without it,
  // a merge-commit or rebase-and-merge repo (lucy's policy is not pinned) would
  // pull in a feature branch's original, much older committer dates and fire a
  // false "lagging" alert the instant a long-lived branch merges.
  const logOut = await git(repoPath, [
    'log',
    '--first-parent',
    `--format=${COMMIT_LOG_FORMAT}`,
    `${deployedSha}..${mainSha}`,
  ]);
  // Distinguish a git failure (null) from a genuinely empty range (""): a failed
  // `log` (timeout / maxBuffer on a huge range — and `log` is NOT retried by
  // git-helpers) must degrade to `unknown`, never be misread as "nothing pending"
  // — that would self-suppress the alert exactly when the lag is largest.
  if (logOut === null) {
    return unavailable(`git log ${deployedSha.slice(0, 7)}..origin/main failed in ${repoPath}`);
  }
  return { target, deployedSha, mainSha, pendingCommits: parseCommitLog(logOut) };
}

/** Default {@link GitReader} — the shared, guarded git subprocess helper. */
export async function defaultGitReader(cwd: string, args: string[]): Promise<string | null> {
  const { gitIn } = await import('../core/git-helpers.js');
  return gitIn(cwd, ...args);
}

/** Default {@link StatusFetcher} — one bounded GET returning parsed JSON. */
export function defaultStatusFetcher(timeoutMs: number): StatusFetcher {
  return async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`status surface ${url} returned HTTP ${res.status}`);
    return res.json();
  };
}
