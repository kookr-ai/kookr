#!/usr/bin/env node
// Deploy-convergence check CLI (issue #1883).
//
// Asserts the invariant "kookr-prod's serving commit includes origin/main HEAD"
// by probing the ACTUAL serving process — GET /api/health publishes the commit
// the running server was built from under `build.commitShort` (see the
// /api/health handler in src/server/routes/diagnostics-routes.ts) — and
// comparing it against origin/main via git ancestry. This applies the lesson
// "self-heal must probe the process that does the work, not the repo the check
// happens to run in": the SHA comes from the live HTTP endpoint, not from the
// worktree the check runs in (which can be advanced-but-not-rebuilt).
//
// Classification + grace-window logic live in src/core/deploy-convergence.ts
// (pure, unit-tested). This script only gathers the cheap inputs, persists a
// baseline so divergence age accrues across ticks, and exits with a contract the
// scheduled playbook keys off:
//   0 — converged, or diverging inside the grace window (no action)
//   2 — DIVERGENT past the grace window (escalate: redeploy, then P0 on failure)
//   1 — probe / IO failure (serving or target SHA unavailable)
//
// With --act, a code-2 divergence also POSTs the canonical redeploy trigger
// (POST /api/deploy/trigger → prod-update.sh, the same path the dashboard button
// and `pnpm prod:update` use). Detection is the default; triggering a real
// deploy is opt-in.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  buildConvergenceBaseline,
  evaluateConvergence,
  extractServingSha,
  formatConvergenceReceipt,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  type ConvergenceResult,
  type ConvergenceThresholds,
} from '../src/core/deploy-convergence.js';

const DEFAULT_PORT = Number(process.env.KOOKR_PORT || 4800) || 4800;
const DEFAULT_BASE = (
  process.env.KOOKR_API_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`
).replace(/\/+$/, '');
const DEFAULT_BRANCH = process.env.DEPLOY_BRANCH || 'main';
const DEFAULT_REPO_DIR =
  process.env.KOOKR_RUNTIME_DIR || process.env.KOOKR_PROD_DIR || process.cwd();
const DEFAULT_STATE_DIR = join(
  process.env.PLAYBOOK_RUNTIME_STATE_ROOT || join(homedir(), '.kookr', 'playbook-state'),
  'kookr',
  'deploy-convergence',
);

type GitRunner = (args: string[]) => string | null;

interface FetchLike {
  (url: string, init?: unknown): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export interface CliArgs {
  base: string;
  branch: string;
  repoDir: string;
  stateDir: string;
  stateFile: string | null;
  act: boolean;
  dryRun: boolean;
  noFetch: boolean;
  json: boolean;
  help: boolean;
  thresholds: Partial<ConvergenceThresholds>;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    base: DEFAULT_BASE,
    branch: DEFAULT_BRANCH,
    repoDir: DEFAULT_REPO_DIR,
    stateDir: DEFAULT_STATE_DIR,
    stateFile: null,
    act: false,
    dryRun: false,
    noFetch: false,
    json: true,
    help: false,
    thresholds: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--act') out.act = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-fetch') out.noFetch = true;
    else if (a === '--no-json') out.json = false;
    else if (a === '--base' && argv[i + 1]) out.base = String(argv[++i]).replace(/\/+$/, '');
    else if (a === '--branch' && argv[i + 1]) out.branch = String(argv[++i]);
    else if (a === '--repo-dir' && argv[i + 1]) out.repoDir = String(argv[++i]);
    else if (a === '--state-dir' && argv[i + 1]) out.stateDir = String(argv[++i]);
    else if (a === '--state-file' && argv[i + 1]) out.stateFile = String(argv[++i]);
    else if (a === '--grace-minutes' && argv[i + 1]) {
      // Guard against NaN / negative: a non-finite grace would make the
      // `age >= grace` divergence test always false (never escalate); a
      // negative grace would fire immediately. Reject either and keep the
      // default so a fat-fingered flag can't silently disable the invariant.
      const g = Number(argv[++i]);
      if (Number.isFinite(g) && g >= 0) {
        out.thresholds.divergenceGraceMinutes = g;
      } else {
        process.stderr.write(
          `deploy-convergence-check: ignoring invalid --grace-minutes "${argv[i]}"; using default ${DEFAULT_CONVERGENCE_THRESHOLDS.divergenceGraceMinutes}\n`,
        );
      }
    }
  }
  if (!out.stateFile) out.stateFile = join(out.stateDir, 'baseline.json');
  return out;
}

function usage(): string {
  return `Usage: node --import tsx scripts/deploy-convergence-check.ts [options]

Assert kookr-prod serving SHA includes origin/${DEFAULT_BRANCH} HEAD (issue #1883).

Options:
  --base <url>            Serving API base (default $KOOKR_API_BASE_URL or http://127.0.0.1:${DEFAULT_PORT})
  --branch <name>         Deploy branch to track (default $DEPLOY_BRANCH or main)
  --repo-dir <path>       Git worktree to resolve origin/<branch> + ancestry (default $KOOKR_RUNTIME_DIR/$KOOKR_PROD_DIR or cwd)
  --state-dir <path>      Baseline dir (default ~/.kookr/playbook-state/kookr/deploy-convergence)
  --state-file <path>     Baseline file (overrides --state-dir)
  --grace-minutes <n>     Divergence grace before it's an incident (default ${DEFAULT_CONVERGENCE_THRESHOLDS.divergenceGraceMinutes})
  --act                   On DIVERGENT, POST /api/deploy/trigger (default: detect only)
  --no-fetch              Skip the pre-comparison 'git fetch origin <branch>' (default: fetch)
  --dry-run               Classify but do not write the baseline or act
  --no-json               Human receipt line only
  -h, --help              Show this help

Exit: 0 converged/within-grace · 2 DIVERGENT · 1 error
`;
}

async function fetchJson(
  url: string,
  { fetchFn = fetch as unknown as FetchLike, timeoutMs = 10_000 }: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<unknown> {
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

// Default git runner: bounded execFileSync with array args (shell-safe, matching
// scripts/generate-build-info.ts). Returns trimmed stdout, or null on any
// failure so callers can degrade gracefully instead of throwing.
export function makeGitRunner(dir: string): GitRunner {
  return (args: string[]) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      }).trim();
    } catch {
      return null;
    }
  };
}

export interface GitTarget {
  targetSha: string | null;
  targetCommittedAtMs: number | null;
  servingIncludesTarget: boolean | null;
}

// Resolve origin/<branch> HEAD + its committer time, and whether it is already
// an ancestor of the serving commit (the real "includes" invariant). Ancestry
// is only decidable when the serving commit is present in this worktree; when it
// isn't we return null and the classifier falls back to SHA identity.
export function resolveGitTarget({
  git,
  branch,
  servingSha,
}: {
  git: GitRunner;
  branch: string;
  servingSha: string | null;
}): GitTarget {
  const targetSha = git(['rev-parse', '--short', `origin/${branch}`]);
  const committedRaw = targetSha ? git(['show', '-s', '--format=%ct', `origin/${branch}`]) : null;
  const committedSec = committedRaw ? Number(committedRaw) : NaN;
  const targetCommittedAtMs = Number.isFinite(committedSec) ? committedSec * 1000 : null;

  let servingIncludesTarget: boolean | null = null;
  const servingResolved = servingSha
    ? git(['rev-parse', '--quiet', '--verify', `${servingSha}^{commit}`])
    : null;
  if (targetSha && servingResolved) {
    servingIncludesTarget = isAncestor(git, `origin/${branch}`, servingResolved);
  }
  return { targetSha, targetCommittedAtMs, servingIncludesTarget };
}

// True iff `ancestor` is an ancestor of (or equal to) `descendant`.
// `git merge-base --is-ancestor A B` exits 0 iff A is an ancestor of B.
// makeGitRunner returns '' on success (no stdout) and null on failure/non-zero,
// so a non-null result means exit 0 → is an ancestor.
function isAncestor(git: GitRunner, ancestor: string, descendant: string): boolean {
  const out = git(['merge-base', '--is-ancestor', ancestor, descendant]);
  return out !== null;
}

function readBaseline(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    // The baseline is a SOFT input — it only anchors divergence age when the
    // merge commit time is unavailable. A missing file is normal; a corrupt or
    // partially-written one must degrade to "no baseline" (null), NOT throw and
    // kill the probe on every tick (which would leave prod divergence
    // undetected until an operator hand-deletes the file). ENOENT/ENOTDIR are
    // silent; anything else (e.g. JSON.parse SyntaxError) is logged once.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      process.stderr.write(
        `deploy-convergence-check: ignoring unreadable baseline ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return null;
  }
}

function writeBaselineAtomic(path: string, baseline: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export interface RedeployRequest {
  requestedAt: string;
  branch: string;
  reason: string;
  status: number;
  response: unknown;
}

// POST the canonical redeploy trigger (POST /api/deploy/trigger → prod-update.sh).
// This is the same path the dashboard "Deploy" button and `pnpm prod:update`
// take; the running server owns locating the prod worktree (resolveProdDir) and
// serializing concurrent deploys (its `deploying` flag → 409). A 409 ("already
// in progress") is treated as success — a redeploy is already underway.
export async function triggerRedeploy({
  base,
  branch,
  reason,
  fetchFn = fetch as unknown as FetchLike,
  nowMs = Date.now(),
}: {
  base: string;
  branch: string;
  reason: string;
  fetchFn?: FetchLike;
  nowMs?: number;
}): Promise<RedeployRequest> {
  const res = await fetchFn(`${base}/api/deploy/trigger`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
  });
  let response: unknown = null;
  try {
    response = await res.json();
  } catch {
    response = null;
  }
  // 2xx = deploy started; 409 = a deploy is already running (also fine).
  if (!res.ok && res.status !== 409) {
    throw new Error(`POST ${base}/api/deploy/trigger → HTTP ${res.status}`);
  }
  return {
    requestedAt: new Date(nowMs).toISOString(),
    branch,
    reason,
    status: res.status,
    response,
  };
}

export interface ProbeResult extends ConvergenceResult {
  branch: string;
  baselineWritten: boolean;
  stateFile: string;
  redeployRequested: RedeployRequest | null;
  /**
   * Set when `--act` fired on a DIVERGENT tick but the redeploy trigger POST
   * failed. The result stays DIVERGENT (exit 2) so the schedule escalates to a
   * P0 — a failed self-heal is the incident, not a transient blip.
   */
  redeployError: string | null;
  receipt: string;
}

export async function runConvergenceProbe({
  base = DEFAULT_BASE,
  branch = DEFAULT_BRANCH,
  repoDir = DEFAULT_REPO_DIR,
  stateFile = join(DEFAULT_STATE_DIR, 'baseline.json'),
  act = false,
  dryRun = false,
  refreshRemote = true,
  thresholds = {},
  fetchFn = fetch as unknown as FetchLike,
  git = makeGitRunner(repoDir),
  nowMs = Date.now(),
}: {
  base?: string;
  branch?: string;
  repoDir?: string;
  stateFile?: string;
  act?: boolean;
  dryRun?: boolean;
  refreshRemote?: boolean;
  thresholds?: Partial<ConvergenceThresholds>;
  fetchFn?: FetchLike;
  git?: GitRunner;
  nowMs?: number;
} = {}): Promise<ProbeResult> {
  const health = await fetchJson(`${base}/api/health`, { fetchFn });
  const servingSha = extractServingSha(health);

  // Refresh the remote-tracking ref BEFORE resolving the target: the invariant
  // compares the serving commit against `origin/${branch}`, and a checkout
  // whose `origin/${branch}` is stale (never fetched since the last merge) would
  // make the probe compare serving against an old target and falsely report
  // "converged" — masking the exact "prod behind merged HEAD" divergence this
  // check exists to catch (#1883). Best-effort: the runner swallows a failed
  // fetch to null, so an offline tick still classifies against whatever ref is
  // present rather than crashing. `--no-fetch` (tests / already-fetched envs)
  // skips it.
  if (refreshRemote) {
    git(['fetch', '--quiet', 'origin', branch]);
  }

  const { targetSha, targetCommittedAtMs, servingIncludesTarget } = resolveGitTarget({
    git,
    branch,
    servingSha,
  });

  const previous = readBaseline(stateFile);
  const result = evaluateConvergence({
    servingSha,
    targetSha,
    servingIncludesTarget,
    targetCommittedAtMs,
    previous,
    thresholds,
    nowMs,
  });

  if (!dryRun && result.ok) {
    writeBaselineAtomic(stateFile, buildConvergenceBaseline(result));
  }

  let redeployRequested: RedeployRequest | null = null;
  let redeployError: string | null = null;
  if (result.action === 'redeploy' && act && !dryRun) {
    try {
      redeployRequested = await triggerRedeploy({
        base,
        branch,
        reason: `deploy-convergence: prod ${servingSha} missing origin/${branch} ${targetSha} for ${result.divergenceAgeMinutes}m (#1883)`,
        fetchFn,
        nowMs,
      });
    } catch (err) {
      // A failed redeploy trigger is NOT a transient probe blip — it is the
      // "self-heal cannot advance prod" condition Phase 3 files a P0 for.
      // Swallowing the throw here (instead of letting it collapse main() to
      // exit 1, which the playbook maps to "do not escalate") preserves the
      // DIVERGENT result → exit 2 → escalation.
      redeployError = err instanceof Error ? err.message : String(err);
      process.stderr.write(`deploy-convergence-check: redeploy trigger FAILED: ${redeployError}\n`);
    }
  }

  return {
    ...result,
    branch,
    baselineWritten: !dryRun && result.ok,
    stateFile,
    redeployRequested,
    redeployError,
    receipt: formatConvergenceReceipt(result),
  };
}

// Exit code from a probe result: 1 on unknown/error, 2 on divergent, else 0.
export function exitCodeForResult(result: ProbeResult | ConvergenceResult | null): number {
  if (!result || !result.ok) return 1;
  if (result.divergent) return 2;
  return 0;
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  try {
    const result = await runConvergenceProbe({
      base: args.base,
      branch: args.branch,
      repoDir: args.repoDir,
      stateFile: args.stateFile ?? undefined,
      act: args.act,
      dryRun: args.dryRun,
      refreshRemote: !args.noFetch,
      thresholds: args.thresholds,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.receipt}\n`);
    }
    return exitCodeForResult(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`deploy-convergence-check: ERROR ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
