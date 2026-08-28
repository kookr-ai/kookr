import { gitIn, runGitIn } from '../core/git-helpers.js';

export interface CheckoutAutoSyncResult {
  /** True when a fetch+rebase was actually attempted (branch present, tree clean). */
  attempted: boolean;
  /** True when the attempted sync completed cleanly. Always false when `attempted` is false. */
  synced: boolean;
  /** Human-readable note to surface to the operator/agent when the sync could not complete. */
  warning?: string;
}

const NOT_ATTEMPTED: CheckoutAutoSyncResult = { attempted: false, synced: false };

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

  const fetch = await runGitIn(cwd, ['fetch', 'origin']);
  if (fetch.kind !== 'ok') {
    console.warn('[checkout-auto-sync] git fetch origin failed', { cwd, branch, result: fetch });
    return {
      attempted: true,
      synced: false,
      warning: `Auto-sync skipped: \`git fetch origin\` failed in \`${cwd}\`.`,
    };
  }

  const pull = await runGitIn(cwd, ['pull', '--rebase']);
  if (pull.kind !== 'ok') {
    // Best-effort cleanup: leave the checkout at its pre-sync HEAD rather
    // than mid-rebase. No-op (fails silently) when there is nothing to abort.
    await runGitIn(cwd, ['rebase', '--abort']);
    console.warn('[checkout-auto-sync] git pull --rebase failed', { cwd, branch, result: pull });
    return {
      attempted: true,
      synced: false,
      warning: `Auto-sync skipped: \`git pull --rebase\` failed in \`${cwd}\` on \`${branch}\` (left at its previous commit).`,
    };
  }

  console.log(`[checkout-auto-sync] synced ${cwd} (${branch}) with origin`);
  return { attempted: true, synced: true };
}
