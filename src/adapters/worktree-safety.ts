import { execFile as execFileCb } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { classifyGitError, DEFAULT_GIT_MAX_BUFFER, DEFAULT_GIT_TIMEOUT_MS } from '../core/git-helpers.js';
import {
  DEFAULT_PROTECTED_BRANCHES,
  isProtectedBranch as isProtectedBranchPure,
} from '../shared/contracts/worktree-protection.js';

const execFile = promisify(execFileCb);

export type WorktreeRemovalGuardReason =
  | 'primary-working-tree'
  | 'not-a-linked-worktree'
  | 'protected-branch';

export interface WorktreeRemovalGuardOptions {
  /** Repository root or common git directory used for registry validation. */
  repoPath?: string;
  branch?: string;
  /** User confirmation is accepted only for protected branches. */
  confirmProtectedBranch?: boolean;
}

async function git(...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', args, {
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      maxBuffer: DEFAULT_GIT_MAX_BUFFER,
    });
    return stdout.trim();
  } catch (err) {
    const kind = classifyGitError(err);
    if (kind !== 'failed') {
      console.warn('[worktree-safety] git subprocess guard tripped', {
        kind,
        args,
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      });
    }
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return normalize(resolve(path));
    }
  };
  return canonical(left) === canonical(right);
}

/**
 * True only when Git reports the target's private git dir is the repository's
 * common git dir. Linked worktrees have a private `.git/worktrees/*` dir and
 * therefore cannot satisfy this comparison.
 */
export async function isPrimaryWorkingTree(worktreePath: string): Promise<boolean> {
  const [gitDir, commonDir] = await Promise.all([
    git('-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir'),
    git('-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
  ]);
  return gitDir !== null && commonDir !== null && samePath(gitDir, commonDir);
}

/**
 * Check the on-disk linked-worktree marker. A primary checkout has a real
 * `.git` directory; a linked worktree has a `.git` file pointing below
 * `.git/worktrees/`.
 */
export function looksLikeLinkedWorktree(worktreePath: string): boolean {
  try {
    const gitPath = join(worktreePath, '.git');
    if (!lstatSync(gitPath).isFile()) return false;
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitPath, 'utf8'));
    if (!match) return false;
    const gitDir = isAbsolute(match[1])
      ? match[1]
      : resolve(dirname(gitPath), match[1]);
    return /(?:^|[\\/])\.git[\\/]worktrees[\\/][^\\/]+$/.test(normalize(gitDir));
  } catch {
    return false;
  }
}

function registeredWorktreeEntries(output: string): Array<{ path: string; bare: boolean }> {
  return output.split(/\n\s*\n/).flatMap((block) => {
    const line = block.split('\n').find((candidate) => candidate.startsWith('worktree '));
    if (!line) return [];
    return [{ path: line.slice('worktree '.length), bare: block.split('\n').includes('bare') }];
  });
}

/**
 * Require registry membership in a non-primary worktree entry. The registry
 * check is the authoritative backstop against arbitrary paths with a forged
 * or stale-looking `.git` file.
 */
export async function isRegisteredLinkedWorktree(
  worktreePath: string,
  repoPath: string,
): Promise<boolean> {
  const output = await git('-C', repoPath, 'worktree', 'list', '--porcelain');
  if (output === null) return false;
  const entries = registeredWorktreeEntries(output);
  const primaryIndex = entries.findIndex((entry) => !entry.bare);
  const matchIndex = entries.findIndex((entry) => !entry.bare && samePath(entry.path, worktreePath));
  return primaryIndex >= 0 && matchIndex > primaryIndex;
}

/** Resolve the repository common directory for a worktree path. */
export async function resolveWorktreeCommonDir(worktreePath: string): Promise<string | null> {
  return git('-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
}

/** Read the configurable server-side protected branch allowlist. */
export function configuredProtectedBranches(): readonly string[] {
  const configured = process.env.KOOKR_PROTECTED_BRANCHES
    ?.split(',')
    .map((branch) => branch.trim())
    .filter(Boolean);
  return configured && configured.length > 0 ? configured : DEFAULT_PROTECTED_BRANCHES;
}

export function isProtectedBranch(
  branch: string | undefined,
  protectedBranches: readonly string[] = configuredProtectedBranches(),
): boolean {
  return isProtectedBranchPure(branch, protectedBranches);
}

/**
 * Return the first hard-stop reason for a removal target. The protected branch
 * check is intentionally last so a primary/non-worktree path keeps its more
 * specific identity even if its recorded branch is also protected.
 */
export async function getWorktreeRemovalGuardReason(
  worktreePath: string,
  options: WorktreeRemovalGuardOptions = {},
): Promise<WorktreeRemovalGuardReason | undefined> {
  if (await isPrimaryWorkingTree(worktreePath)) return 'primary-working-tree';
  if (!looksLikeLinkedWorktree(worktreePath)) return 'not-a-linked-worktree';

  const repoPath = options.repoPath ?? await resolveWorktreeCommonDir(worktreePath);
  if (!repoPath || !await isRegisteredLinkedWorktree(worktreePath, repoPath)) {
    return 'not-a-linked-worktree';
  }

  if (isProtectedBranch(options.branch) && !options.confirmProtectedBranch) {
    return 'protected-branch';
  }
  return undefined;
}
