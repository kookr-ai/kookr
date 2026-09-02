import { gitIn, runGitIn } from '../core/git-helpers.js';
import type { SchedulePlaybookCheckoutSource } from '../core/schedule.js';
import { canonicalizeCwd } from './cwd.js';

export interface CheckoutAutoSyncResult {
  /** True when a fetch+rebase was actually attempted (branch present, tree clean). */
  attempted: boolean;
  /** True when the attempted sync completed cleanly. Always false when `attempted` is false. */
  synced: boolean;
  /** Human-readable note to surface to the operator/agent when the sync could not complete. */
  warning?: string;
}

const NOT_ATTEMPTED: CheckoutAutoSyncResult = { attempted: false, synced: false };

// A manual launch is a synchronous step in an HTTP request (task-routes.ts
// awaits launchTask directly), so a hung/unreachable origin must fail fast
// rather than eating the default 30s-times-3-attempt git-helpers budget
// (~94s on fetch alone). One attempt, capped short, on both git network
// calls — this feature already fails open, so losing fetch's transient-error
// retry trades a rare extra warning for a bounded worst case.
const SYNC_GIT_TIMEOUT_MS = 10_000;
const SYNC_GIT_OPTIONS = { timeoutMs: SYNC_GIT_TIMEOUT_MS, maxAttempts: 1 };

// Coalesces concurrent calls for the same checkout (e.g. two manual launches
// into the same project fired close together) onto a single in-flight sync,
// so two `git fetch`/`pull --rebase` invocations never race on one working
// tree. Keyed by canonicalized cwd so path variants (symlinks, trailing
// slash) still share one entry.
const inFlightSyncs = new Map<string, Promise<CheckoutAutoSyncResult>>();

/**
 * Best-effort `git fetch origin` + `git pull --rebase` against `cwd`, run
 * before a manual (human-triggered) Kookr launch so the ambient checkout a
 * worktree gets branched from — and that an operator might be reading — is
 * never stale. Opt-in per project via `ProjectConfig.autoSyncOnManualLaunch`;
 * callers gate on that before invoking this function.
 *
 * Fails open by design: a detached HEAD, a dirty tree, or any git failure
 * is left untouched and reported back as a warning rather than blocking the
 * launch. `cwd` should always be clean under Kookr's worktree-isolation
 * policy (tracked-file edits happen in a task's own worktree, never here),
 * so a dirty tree here is itself a signal worth surfacing, not something to
 * paper over with `--autostash`.
 */
export async function autoSyncCheckoutForManualLaunch(cwd: string): Promise<CheckoutAutoSyncResult> {
  const key = canonicalizeCwd(cwd);
  const existing = inFlightSyncs.get(key);
  if (existing) return existing;

  const promise = runSync(cwd).finally(() => {
    inFlightSyncs.delete(key);
  });
  inFlightSyncs.set(key, promise);
  return promise;
}

async function runSync(cwd: string): Promise<CheckoutAutoSyncResult> {
  const branch = await gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch || branch === 'HEAD') return NOT_ATTEMPTED; // detached HEAD — nothing to rebase onto

  const status = await gitIn(cwd, 'status', '--porcelain');
  if (status === null) return NOT_ATTEMPTED; // git status itself failed — not a normal git checkout
  if (status.length > 0) {
    return {
      attempted: false,
      synced: false,
      warning: `Auto-sync skipped: \`${cwd}\` has uncommitted changes on \`${branch}\` — left untouched.`,
    };
  }

  const fetch = await runGitIn(cwd, ['fetch', 'origin'], SYNC_GIT_OPTIONS);
  if (fetch.kind !== 'ok') {
    console.warn('[checkout-auto-sync] git fetch origin failed', { cwd, branch, result: fetch });
    return {
      attempted: true,
      synced: false,
      warning: `Auto-sync skipped: \`git fetch origin\` failed in \`${cwd}\`.`,
    };
  }

  const pull = await runGitIn(cwd, ['pull', '--rebase'], SYNC_GIT_OPTIONS);
  if (pull.kind !== 'ok') {
    // Best-effort cleanup: leave the checkout at its pre-sync HEAD rather
    // than mid-rebase. No-op (fails silently) when there is nothing to abort
    // — but if the checkout was mid-rebase and the abort ITSELF fails, say
    // so explicitly rather than falsely claiming a clean recovery.
    const abort = await runGitIn(cwd, ['rebase', '--abort']);
    const abortedCleanly = abort.kind === 'ok';
    console.warn('[checkout-auto-sync] git pull --rebase failed', { cwd, branch, result: pull, abortedCleanly });
    return {
      attempted: true,
      synced: false,
      warning: abortedCleanly
        ? `Auto-sync skipped: \`git pull --rebase\` failed in \`${cwd}\` on \`${branch}\` (left at its previous commit).`
        : `Auto-sync skipped: \`git pull --rebase\` failed in \`${cwd}\` on \`${branch}\`, and the automatic \`git rebase --abort\` cleanup also failed — inspect this checkout's state manually.`,
    };
  }

  console.log(`[checkout-auto-sync] synced ${cwd} (${branch}) with origin`);
  return { attempted: true, synced: true };
}

/**
 * Git provenance of the playbook text a schedule fire actually read (issue
 * #2945). Surfaces on the schedule receipt so a silent stale checkout cannot
 * hide that the agent ran old instructions.
 */
export interface PlaybookCheckoutDrift {
  /** HEAD commit SHA of the playbook source checkout. */
  ref: string;
  /** Upstream tracking ref, e.g. `origin/main`. */
  upstreamRef: string;
  /** Commits HEAD is behind `@{u}`. Zero when current or ahead. */
  behindBy: number;
  /**
   * True when the playbook blob at HEAD differs from the same path at `@{u}`,
   * or when HEAD is behind upstream even if that file currently matches.
   */
  drifted: boolean;
  /** True when the playbook blob at HEAD differs from the same path at `@{u}`. */
  blobDiffers: boolean;
  /** Agent-facing warning. Present only when `drifted` is true. */
  warning?: string;
}

export function toSchedulePlaybookSource(drift: PlaybookCheckoutDrift): SchedulePlaybookCheckoutSource {
  return {
    ref: drift.ref,
    upstreamRef: drift.upstreamRef,
    behindBy: drift.behindBy,
    drifted: drift.drifted,
  };
}

/**
 * Compare a project-tier playbook file in `cwd` against the checkout's
 * upstream tracking ref (issue #2945).
 *
 * Fetch-free against the already-known remote-tracking ref is enough to catch
 * a checkout that has not been fast-forwarded after a local fetch. An
 * opportunistic `git fetch --quiet` of the tracked branch is attempted first
 * so a checkout that has not fetched recently still sees upstream playbook
 * edits — bounded to one attempt and {@link SYNC_GIT_TIMEOUT_MS} so a hung
 * origin cannot stall the schedule hot path. Fetch failure is fail-open: the
 * comparison still runs against the last-known remote ref.
 *
 * Returns `null` when `cwd` is not a git worktree, has no upstream, or git
 * itself fails — never throws, never blocks a run.
 */
export async function inspectPlaybookCheckoutDrift(
  cwd: string,
  playbookGitPath: string,
): Promise<PlaybookCheckoutDrift | null> {
  const inside = await driftGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return null;

  const headSha = await driftGit(cwd, ['rev-parse', 'HEAD']);
  if (!headSha) return null;

  const upstreamRef = await driftGit(cwd, ['rev-parse', '--abbrev-ref', '@{u}']);
  if (!upstreamRef) return null;

  const slash = upstreamRef.indexOf('/');
  if (slash > 0) {
    const remote = upstreamRef.slice(0, slash);
    const branch = upstreamRef.slice(slash + 1);
    // Best-effort: refresh the tracking ref so a checkout that has not
    // fetched recently still sees playbook edits already on origin. One
    // attempt, short timeout; ignore the result.
    await runGitIn(cwd, ['fetch', '--quiet', remote, branch], SYNC_GIT_OPTIONS);
  }

  const upstreamSha = await driftGit(cwd, ['rev-parse', '@{u}']);
  if (!upstreamSha) return null;

  const behindRaw = await driftGit(cwd, ['rev-list', '--count', 'HEAD..@{u}']);
  const behindBy = behindRaw !== null && /^\d+$/.test(behindRaw) ? Number(behindRaw) : 0;

  const headBlob = await driftGit(cwd, ['rev-parse', `HEAD:${playbookGitPath}`]);
  const upstreamBlob = await driftGit(cwd, ['rev-parse', `@{u}:${playbookGitPath}`]);
  // Both-null (file in neither tree, or git failed both lookups) is fail-open
  // — not a blob difference. One-sided null means the path exists on only
  // one side.
  const blobDiffers = headBlob !== upstreamBlob;
  const drifted = blobDiffers || behindBy > 0;

  if (!drifted) {
    return { ref: headSha, upstreamRef, behindBy: 0, drifted: false, blobDiffers: false };
  }

  return {
    ref: headSha,
    upstreamRef,
    behindBy,
    drifted: true,
    blobDiffers,
    warning: formatPlaybookCheckoutDriftWarning({
      ref: headSha,
      upstreamRef,
      behindBy,
      blobDiffers,
      playbookGitPath,
    }),
  };
}

export function formatPlaybookCheckoutDriftWarning(input: {
  ref: string;
  upstreamRef: string;
  behindBy: number;
  blobDiffers: boolean;
  playbookGitPath: string;
  failClosed?: boolean;
}): string {
  const head = shortenSha(input.ref);
  const behindClause = input.behindBy > 0
    ? `HEAD ${head} is ${input.behindBy === 1 ? '1 commit' : `${input.behindBy} commits`} behind \`${input.upstreamRef}\`.`
    : `HEAD ${head} has a different playbook blob than \`${input.upstreamRef}\`.`;
  const fileNote = input.blobDiffers
    ? `The playbook file \`${input.playbookGitPath}\` differs from upstream.`
    : `The playbook file \`${input.playbookGitPath}\` currently matches upstream, but the checkout is still behind — later playbook edits may be missing.`;
  const closer = input.failClosed
    ? 'This schedule is configured to fail closed on playbook cwd lag, so the run was skipped.'
    : 'This warning does not block the run.';
  return (
    `WARNING: This scheduled playbook's cwd checkout lags its upstream. `
    + `${behindClause} `
    + `${fileNote} `
    + `A fix already merged upstream may not be in effect. `
    + `Fast-forward this checkout before re-deriving a local fix. `
    + closer
  );
}

function shortenSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

async function driftGit(cwd: string, args: string[]): Promise<string | null> {
  const result = await runGitIn(cwd, args, SYNC_GIT_OPTIONS);
  return result.kind === 'ok' ? result.stdout : null;
}
