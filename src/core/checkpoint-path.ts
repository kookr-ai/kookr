import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { repoKeyFor, slugifyForCheckpointKey } from './checkpoint-key.js';

interface ResolveCheckpointDirOptions {
  cwd: string;
  kookrDataDir: string;
}

/**
 * Resolve the per-(repo, branch) checkpoint directory for a task and
 * pre-create it. Returns null on any failure — the caller treats checkpoint
 * support as a strictly additive optimization that must never break task
 * launch.
 *
 * Failure modes (all return null, fail-open):
 *   - cwd is not in a git repo
 *   - cwd is on a detached HEAD (no symbolic branch name)
 *   - kookrDataDir contains shell glob metacharacters that would silently
 *     break the Claude Code permission allowlist matching
 *   - mkdir fails (disk full, permission denied, etc.)
 *
 * The directory is keyed on `(git-common-dir, branch)` so that two Kookr
 * tasks days apart on the same branch share the same checkpoint directory.
 * This is the v5 design — see docs/poc/005-checkpoint-cycle-mechanics.md.
 *
 * For a linked worktree, the **common dir** is shared with the main repo
 * (so two worktrees of the same repo on different branches both key under
 * the same `repoKey`) but the **branch name** is read from the worktree's
 * own gitdir — `<common>/worktrees/<name>/HEAD` — not the common dir's
 * HEAD. Reading from the common dir would return the main repo's branch
 * for every worktree.
 */
export async function resolveAndPrepareCheckpointDir(
  opts: ResolveCheckpointDirOptions,
): Promise<string | null> {
  if (containsShellMetacharacters(opts.kookrDataDir)) {
    return null;
  }

  const gitInfo = await resolveGitDirs(opts.cwd);
  if (!gitInfo) return null;

  const branch = await readBranchName(gitInfo.headDir);
  if (!branch) return null;

  const repoKey = repoKeyFor(gitInfo.commonDir);
  const branchSlug = slugifyForCheckpointKey(branch);
  const dir = join(opts.kookrDataDir, 'checkpoints', repoKey, branchSlug);

  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function containsShellMetacharacters(path: string): boolean {
  return /[\s$(){}[\]*?"'`\\!]/.test(path);
}

interface GitDirs {
  /** The git common dir (shared across worktrees of the same repo). */
  commonDir: string;
  /** The dir that holds THIS worktree's HEAD file. Equals commonDir for the primary worktree. */
  headDir: string;
}

async function resolveGitDirs(cwd: string): Promise<GitDirs | null> {
  const gitPath = join(cwd, '.git');
  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    return null;
  }

  if (gitStat.isDirectory()) {
    // Primary worktree: .git is the common dir AND the head dir.
    const dir = resolve(gitPath);
    return { commonDir: dir, headDir: dir };
  }

  if (!gitStat.isFile()) return null;

  // Linked worktree: .git is a file containing `gitdir: <linked-git-dir>`.
  // The linked git dir is at `<common>/worktrees/<name>` and contains this
  // worktree's HEAD. The common dir is two levels up (`worktrees/..` →
  // common dir).
  let content: string;
  try {
    content = await readFile(gitPath, 'utf-8');
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  const linkedGitDir = resolve(match[1].trim());
  const commonDir = resolve(linkedGitDir, '..', '..');
  return { commonDir, headDir: linkedGitDir };
}

async function readBranchName(headDir: string): Promise<string | null> {
  // Read HEAD directly rather than shelling to git. This is faster, has no
  // dependency on `git` being on PATH, and the format is stable.
  //
  // `headDir` is the dir that holds this worktree's HEAD — for a linked
  // worktree that is the linked git dir, NOT the common dir.
  let head: string;
  try {
    head = await readFile(join(headDir, 'HEAD'), 'utf-8');
  } catch {
    return null;
  }
  const trimmed = head.trim();
  // Symbolic ref: "ref: refs/heads/<branch>"
  const m = trimmed.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (m) return m[1];
  // Detached HEAD (just a sha) — no branch
  return null;
}
