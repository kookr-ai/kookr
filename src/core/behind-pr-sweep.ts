/**
 * Green-but-BEHIND PR sweep (issue #1574).
 *
 * Under strict branch protection (`strict=true` + a required status context),
 * a PR that is MERGEABLE with every check green still cannot merge once `main`
 * advances: it sits `mergeStateStatus=BEHIND` until its branch is updated.
 * GitHub's native auto-merge does NOT push that update for a strict-protected
 * branch — it only merges once the branch is already up to date — so BEHIND
 * green PRs accumulate as delivery debt (evidence: PR #1515 sat BEHIND for
 * 4+ days while main advanced 16 commits). See
 * docs/reports/2026-07-28-behind-pr-sweep-native-automerge-evaluation.md.
 *
 * This module is the deterministic core of the scheduled sweep that drains
 * that class of debt. The planner (`planBehindPrSweep`) is pure — it maps a
 * batch of normalized PR states to an ordered list of actions
 * (update-branch / merge / skip-with-reason) and performs no I/O, so the
 * eligibility policy is exhaustively unit-testable. The runner
 * (`runBehindPrSweep`) executes a plan through an injected {@link SweepExecutor}
 * so the merge/update side effects are testable with a fake executor; the real
 * `gh`-backed executor lives in {@link createGhSweepExecutor}.
 *
 * Safety invariant: draft, CONFLICTING/DIRTY, and failing/pending-check PRs are
 * never updated or merged — they resolve to `skip` before any executor call.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Normalized mergeability, mirroring GitHub's `mergeable` GraphQL enum. */
export type SweepMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/**
 * Normalized `mergeStateStatus` (GitHub GraphQL enum). Only BEHIND (needs a
 * branch update) and CLEAN (ready to merge) are actioned; every other value is
 * skipped with the status as its reason.
 */
export type SweepMergeStateStatus =
  | 'BEHIND'
  | 'BLOCKED'
  | 'CLEAN'
  | 'DIRTY'
  | 'DRAFT'
  | 'HAS_HOOKS'
  | 'UNKNOWN'
  | 'UNSTABLE';

/** Rolled-up state of a PR's status checks. */
export type SweepCheckState = 'passing' | 'pending' | 'failing' | 'none';

/** The action the sweep decided to take for one PR. */
export type SweepAction = 'update-branch' | 'merge' | 'skip';

/** Normalized, self-contained PR snapshot the planner reasons over. */
export interface SweepPrState {
  number: number;
  title: string;
  isDraft: boolean;
  mergeable: SweepMergeable;
  mergeStateStatus: SweepMergeStateStatus;
  checks: SweepCheckState;
}

/** One planned decision. `outcome` is filled in by the runner, not the planner. */
export interface SweepPlanEntry {
  number: number;
  title: string;
  action: SweepAction;
  reason: string;
}

/** A raw `gh pr list` status-check rollup entry (only the fields we read). */
export interface RawCheckRollupEntry {
  /** Check runs use `status`/`conclusion`; legacy status contexts use `state`. */
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

/** Subset of `gh pr list --json ...` fields this module consumes. */
export interface RawPrListEntry {
  number: number;
  title?: string | null;
  isDraft?: boolean | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  statusCheckRollup?: RawCheckRollupEntry[] | null;
}

/** The `--json` field list to request from `gh pr list` for a sweep. */
export const GH_PR_LIST_JSON_FIELDS =
  'number,title,isDraft,mergeable,mergeStateStatus,statusCheckRollup';

/**
 * Collapse a `statusCheckRollup` array into a single {@link SweepCheckState}.
 *
 * Precedence is fail-safe: any failure ⇒ `failing`; else any not-yet-complete
 * check ⇒ `pending`; else if at least one check completed successfully ⇒
 * `passing`; an empty/absent rollup ⇒ `none` (we cannot confirm green).
 */
export function summarizeCheckState(rollup: readonly RawCheckRollupEntry[] | null | undefined): SweepCheckState {
  if (!rollup || rollup.length === 0) return 'none';

  let anyPending = false;
  let anySuccess = false;

  for (const entry of rollup) {
    const status = (entry.status ?? '').toUpperCase();
    const conclusion = (entry.conclusion ?? '').toUpperCase();
    const legacyState = (entry.state ?? '').toUpperCase();

    // Legacy status contexts report a single `state` field.
    if (legacyState) {
      if (legacyState === 'FAILURE' || legacyState === 'ERROR') return 'failing';
      if (legacyState === 'PENDING' || legacyState === 'EXPECTED') { anyPending = true; continue; }
      if (legacyState === 'SUCCESS') { anySuccess = true; continue; }
      continue;
    }

    // Check runs: a terminal `conclusion` decides, otherwise the run is pending.
    if (status && status !== 'COMPLETED') { anyPending = true; continue; }
    switch (conclusion) {
      case 'FAILURE':
      case 'TIMED_OUT':
      case 'CANCELLED':
      case 'ACTION_REQUIRED':
      case 'STARTUP_FAILURE':
      case 'STALE':
        return 'failing';
      case 'SUCCESS':
        anySuccess = true;
        break;
      case 'NEUTRAL':
      case 'SKIPPED':
        break; // non-blocking, ignored
      case '':
        anyPending = true;
        break;
      default:
        anyPending = true;
        break;
    }
  }

  if (anyPending) return 'pending';
  if (anySuccess) return 'passing';
  return 'none';
}

/** Coerce an unknown `gh` string into a {@link SweepMergeable} (default UNKNOWN). */
function normalizeMergeable(value: string | null | undefined): SweepMergeable {
  const upper = (value ?? '').toUpperCase();
  if (upper === 'MERGEABLE' || upper === 'CONFLICTING') return upper;
  return 'UNKNOWN';
}

/** Coerce an unknown `gh` string into a {@link SweepMergeStateStatus} (default UNKNOWN). */
function normalizeMergeStateStatus(value: string | null | undefined): SweepMergeStateStatus {
  const upper = (value ?? '').toUpperCase();
  switch (upper) {
    case 'BEHIND':
    case 'BLOCKED':
    case 'CLEAN':
    case 'DIRTY':
    case 'DRAFT':
    case 'HAS_HOOKS':
    case 'UNSTABLE':
      return upper;
    default:
      return 'UNKNOWN';
  }
}

/** Parse raw `gh pr list --json` rows into normalized {@link SweepPrState}s. */
export function parsePrList(raw: readonly RawPrListEntry[]): SweepPrState[] {
  return raw.map((entry) => ({
    number: entry.number,
    title: entry.title ?? '',
    isDraft: entry.isDraft === true,
    mergeable: normalizeMergeable(entry.mergeable),
    mergeStateStatus: normalizeMergeStateStatus(entry.mergeStateStatus),
    checks: summarizeCheckState(entry.statusCheckRollup),
  }));
}

/**
 * Decide, purely, what the sweep should do with a single PR.
 *
 * The guard order encodes the safety invariant: exclusions (draft, conflicting,
 * unknown mergeability, non-green checks) are evaluated before any actionable
 * branch, so an unsafe PR can never reach `update-branch` or `merge`.
 */
export function decidePrAction(pr: SweepPrState): SweepPlanEntry {
  const base = { number: pr.number, title: pr.title };

  if (pr.isDraft || pr.mergeStateStatus === 'DRAFT') {
    return { ...base, action: 'skip', reason: 'draft' };
  }
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    return { ...base, action: 'skip', reason: 'conflicting with base branch' };
  }
  if (pr.mergeable === 'UNKNOWN') {
    return { ...base, action: 'skip', reason: 'mergeability not yet computed by GitHub' };
  }
  if (pr.checks === 'failing') {
    return { ...base, action: 'skip', reason: 'failing checks' };
  }
  if (pr.checks === 'pending') {
    return { ...base, action: 'skip', reason: 'checks still running' };
  }
  if (pr.checks === 'none') {
    return { ...base, action: 'skip', reason: 'no completed checks reported' };
  }
  // checks === 'passing' from here on.
  if (pr.mergeStateStatus === 'BEHIND') {
    return { ...base, action: 'update-branch', reason: 'behind base branch; checks green' };
  }
  if (pr.mergeStateStatus === 'CLEAN') {
    return { ...base, action: 'merge', reason: 'up to date; checks green' };
  }
  return {
    ...base,
    action: 'skip',
    reason: `not actionable (merge state: ${pr.mergeStateStatus.toLowerCase()})`,
  };
}

/** Plan the full sweep: one {@link SweepPlanEntry} per PR, input order preserved. */
export function planBehindPrSweep(prs: readonly SweepPrState[]): SweepPlanEntry[] {
  return prs.map(decidePrAction);
}

/** Result of executing one side effect. */
export interface SweepExecResult {
  ok: boolean;
  detail?: string;
}

/**
 * Side-effect boundary the runner drives. Injected so the runner is testable
 * without touching GitHub; {@link createGhSweepExecutor} is the real impl.
 */
export interface SweepExecutor {
  /** Run `gh pr update-branch <number>` (rebase/merge base into the PR branch). */
  updateBranch(number: number): Promise<SweepExecResult>;
  /** Run `gh pr merge <number> --squash`. */
  merge(number: number): Promise<SweepExecResult>;
  /** Re-fetch one PR's state after an update, to see if it is now merge-ready. */
  refetch(number: number): Promise<SweepPrState | null>;
}

/** Terminal outcome the runner records for one PR. */
export type SweepOutcome = 'merged' | 'updated' | 'skipped' | 'failed';

/** One row of the sweep audit trail. */
export interface SweepAuditEntry {
  number: number;
  title: string;
  action: SweepAction;
  outcome: SweepOutcome;
  reason: string;
}

export interface SweepRunResult {
  audit: SweepAuditEntry[];
  merged: number[];
  updated: number[];
  skipped: number[];
  failed: number[];
}

export interface RunSweepOptions {
  /** When true, plan and log but perform no update/merge (no executor calls). */
  dryRun?: boolean;
}

/**
 * Execute a planned sweep through {@link SweepExecutor}.
 *
 * For a BEHIND green PR the runner updates its branch, then re-fetches: if the
 * branch is now CLEAN with checks already green (a fast-forwardable base whose
 * checks did not need to re-run), it merges on the same pass — satisfying
 * "merged by the mechanism's first run". Otherwise the update stands and the
 * merge defers to a later sweep once CI settles.
 */
export async function runBehindPrSweep(
  prs: readonly SweepPrState[],
  executor: SweepExecutor,
  options: RunSweepOptions = {},
): Promise<SweepRunResult> {
  const plan = planBehindPrSweep(prs);
  const result: SweepRunResult = { audit: [], merged: [], updated: [], skipped: [], failed: [] };

  for (const entry of plan) {
    if (entry.action === 'skip') {
      record(result, { ...entry, outcome: 'skipped' });
      continue;
    }

    if (options.dryRun) {
      record(result, {
        ...entry,
        outcome: 'skipped',
        reason: `dry-run: would ${entry.action} (${entry.reason})`,
      });
      continue;
    }

    if (entry.action === 'merge') {
      await doMerge(executor, entry, result);
      continue;
    }

    // action === 'update-branch'
    const updated = await executor.updateBranch(entry.number);
    if (!updated.ok) {
      record(result, {
        ...entry,
        outcome: 'failed',
        reason: `update-branch failed${updated.detail ? `: ${updated.detail}` : ''}`,
      });
      continue;
    }

    const refetched = await executor.refetch(entry.number);
    const nextAction = refetched ? decidePrAction(refetched) : null;
    if (nextAction && nextAction.action === 'merge') {
      await doMerge(executor, { number: entry.number, title: entry.title, action: 'merge', reason: nextAction.reason }, result);
      continue;
    }

    record(result, {
      ...entry,
      outcome: 'updated',
      reason: refetched
        ? `branch updated; merge deferred (${nextAction?.reason ?? 'not yet ready'})`
        : 'branch updated; merge deferred (state re-fetch unavailable)',
    });
  }

  return result;
}

async function doMerge(
  executor: SweepExecutor,
  entry: Pick<SweepPlanEntry, 'number' | 'title' | 'reason'> & { action: SweepAction },
  result: SweepRunResult,
): Promise<void> {
  const merged = await executor.merge(entry.number);
  if (merged.ok) {
    record(result, { number: entry.number, title: entry.title, action: 'merge', outcome: 'merged', reason: entry.reason });
  } else {
    record(result, {
      number: entry.number,
      title: entry.title,
      action: 'merge',
      outcome: 'failed',
      reason: `merge failed${merged.detail ? `: ${merged.detail}` : ''}`,
    });
  }
}

function record(result: SweepRunResult, audit: SweepAuditEntry): void {
  result.audit.push(audit);
  switch (audit.outcome) {
    case 'merged': result.merged.push(audit.number); break;
    case 'updated': result.updated.push(audit.number); break;
    case 'skipped': result.skipped.push(audit.number); break;
    case 'failed': result.failed.push(audit.number); break;
  }
}

/**
 * Render a sweep result as a human-readable audit log. Every PR the sweep saw
 * appears exactly once with its outcome and reason (AC: "each sweep produces an
 * audit log listing every PR it touched and the action taken or skip reason").
 */
export function renderSweepAuditLog(result: SweepRunResult, generatedAt: string): string {
  const lines: string[] = [];
  lines.push(`[behind-pr-sweep] ${generatedAt}`);
  if (result.audit.length === 0) {
    lines.push('  no open PRs to evaluate');
  }
  for (const row of result.audit) {
    lines.push(`  #${row.number} [${row.outcome}] ${row.reason} — "${row.title}"`);
  }
  lines.push(
    `  summary: ${result.merged.length} merged, ${result.updated.length} updated, ` +
      `${result.skipped.length} skipped, ${result.failed.length} failed`,
  );
  return lines.join('\n');
}

// --- Real `gh`-backed executor -------------------------------------------------

async function runGh(args: string[]): Promise<SweepExecResult> {
  try {
    await execFileAsync('gh', args, { maxBuffer: 10 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { ok: false, detail };
  }
}

/**
 * Build a {@link SweepExecutor} backed by the `gh` CLI for a given `owner/repo`.
 * Uses `execFile` with array args (no shell) per shell-subprocess-safety.
 */
export function createGhSweepExecutor(ownerRepo: string): SweepExecutor {
  return {
    updateBranch: (number) => runGh(['pr', 'update-branch', String(number), '-R', ownerRepo]),
    merge: (number) => runGh(['pr', 'merge', String(number), '-R', ownerRepo, '--squash']),
    refetch: async (number) => {
      try {
        const { stdout } = await execFileAsync(
          'gh',
          ['pr', 'view', String(number), '-R', ownerRepo, '--json', GH_PR_LIST_JSON_FIELDS],
          { maxBuffer: 10 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout) as RawPrListEntry;
        return parsePrList([parsed])[0] ?? null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * List a repo's open PRs via `gh pr list` and normalize them. Returns `null`
 * when the `gh` call fails (auth/rate-limit) so the caller can skip the sweep
 * rather than treat "no data" as "no work".
 */
export async function listOpenPrsForSweep(ownerRepo: string): Promise<SweepPrState[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '-R', ownerRepo, '--state', 'open', '--limit', '100', '--json', GH_PR_LIST_JSON_FIELDS],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    const raw = JSON.parse(stdout) as RawPrListEntry[];
    return parsePrList(raw);
  } catch {
    return null;
  }
}
