import { execFile as execFileCb } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { classifyGitError, DEFAULT_GIT_MAX_BUFFER, DEFAULT_GIT_TIMEOUT_MS, gitExecEnv } from '../core/git-helpers.js';
import {
  DEFAULT_PROTECTED_BRANCHES,
  isProtectedBranch as isProtectedBranchPure,
} from '../shared/contracts/worktree-protection.js';

const execFile = promisify(execFileCb);

export type WorktreeRemovalGuardReason =
  | 'primary-working-tree'
  | 'not-a-linked-worktree'
  | 'protected-branch'
  | 'repository-context-unavailable'
  | 'repository-context-mismatch';

export type WorktreeRemovalFailureReason =
  | WorktreeRemovalGuardReason
  | 'worktree-identity-changed'
  | 'git-remove-failed';

export interface WorktreeRemovalGuardOptions {
  /** Repository root or common git directory used for registry validation. */
  repoPath?: string;
  /** Retained as request metadata compatibility; current Git branch wins. */
  branch?: string;
  /** User confirmation is accepted only for protected branches. */
  confirmProtectedBranch?: boolean;
}

export interface RegisteredWorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
}

export interface WorktreeRemovalTarget {
  worktreePath: string;
  commonDir: string;
  gitDir: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: false;
}

export interface WorktreeRemovalInspection {
  target?: WorktreeRemovalTarget;
  reason?: WorktreeRemovalGuardReason;
}

export interface RemoveRegisteredWorktreeOptions extends WorktreeRemovalGuardOptions {
  force?: boolean;
  signal?: AbortSignal;
  /** Full HEAD SHA or a Git short-SHA prefix of at least seven characters. */
  expectedHead?: string;
  expectedBranch?: string;
  expectedDetached?: boolean;
  expectedGitDir?: string;
}

export interface RemoveRegisteredWorktreeResult {
  removed: boolean;
  reason?: WorktreeRemovalFailureReason;
  target?: WorktreeRemovalTarget;
  stderr?: string;
}

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function runGit(...args: string[]): Promise<GitCommandResult> {
  return runGitWithSignal(args);
}

async function runGitWithSignal(args: string[], signal?: AbortSignal): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFile('git', args, {
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      env: gitExecEnv(),
      signal,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
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
    const stderr = err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr?: string }).stderr ?? '')
      : err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: '', stderr: stderr.trim() };
  }
}

async function git(...args: string[]): Promise<string | null> {
  const result = await runGit(...args);
  return result.ok ? result.stdout : null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalize(resolve(path));
  }
}

/** Compare filesystem paths after resolving symlinks where possible. */
export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

/** Parse Git's porcelain worktree registry without relying on block order. */
export function parseRegisteredWorktreeEntries(output: string): RegisteredWorktreeEntry[] {
  return output.split(/\r?\n\s*\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    if (!worktreeLine) return [];
    const branchLine = lines.find((line) => line.startsWith('branch '));
    const headLine = lines.find((line) => line.startsWith('HEAD '));
    return [{
      path: worktreeLine.slice('worktree '.length),
      head: headLine?.slice('HEAD '.length),
      branch: branchLine?.slice('branch '.length).replace(/^refs\/heads\//, ''),
      bare: lines.includes('bare'),
      detached: lines.includes('detached'),
    }];
  });
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
 * `.git/worktrees/` or a bare repository's `worktrees/` directory.
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
    // A normal repository uses `.git/worktrees/<id>`; a bare repository used
    // as the common dir uses `worktrees/<id>`. Registry membership remains the
    // authority, so this is only a cheap linked-worktree shape check.
    return /(?:^|[\\/])worktrees[\\/][^\\/]+$/.test(normalize(gitDir));
  } catch {
    return false;
  }
}

/** Resolve the repository common directory for a worktree or repository path. */
export async function resolveWorktreeCommonDir(worktreePath: string): Promise<string | null> {
  return git('-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
}

/** Resolve the target's private Git administrative directory. */
async function resolveWorktreeGitDir(worktreePath: string): Promise<string | null> {
  return git('-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir');
}

/**
 * Require registry membership in an exact non-primary worktree entry. Bare
 * entries are valid registry data but are never removable targets.
 */
export async function isRegisteredLinkedWorktree(
  worktreePath: string,
  repoPath: string,
): Promise<boolean> {
  if (await isPrimaryWorkingTree(worktreePath)) return false;
  const output = await git('-C', repoPath, 'worktree', 'list', '--porcelain');
  if (output === null) return false;
  return parseRegisteredWorktreeEntries(output).some((entry) => (
    !entry.bare && samePath(entry.path, worktreePath)
  ));
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

/** Inspect current Git identity and protection state for a removal target. */
export async function inspectWorktreeRemovalTarget(
  worktreePath: string,
  options: WorktreeRemovalGuardOptions = {},
): Promise<WorktreeRemovalInspection> {
  if (await isPrimaryWorkingTree(worktreePath)) {
    return { reason: 'primary-working-tree' };
  }
  if (!looksLikeLinkedWorktree(worktreePath)) {
    return { reason: 'not-a-linked-worktree' };
  }

  const [commonDir, gitDir] = await Promise.all([
    resolveWorktreeCommonDir(worktreePath),
    resolveWorktreeGitDir(worktreePath),
  ]);
  if (!commonDir || !gitDir) {
    return { reason: 'repository-context-unavailable' };
  }

  if (options.repoPath) {
    const expectedCommonDir = await resolveWorktreeCommonDir(options.repoPath);
    if (!expectedCommonDir) return { reason: 'repository-context-unavailable' };
    if (!samePath(commonDir, expectedCommonDir)) {
      return { reason: 'repository-context-mismatch' };
    }
  }

  const output = await git('-C', commonDir, 'worktree', 'list', '--porcelain');
  if (output === null) return { reason: 'repository-context-unavailable' };
  const entry = parseRegisteredWorktreeEntries(output).find((candidate) => (
    !candidate.bare && samePath(candidate.path, worktreePath)
  ));
  if (!entry || !entry.head) return { reason: 'not-a-linked-worktree' };

  if (isProtectedBranch(entry.branch) && !options.confirmProtectedBranch) {
    return { reason: 'protected-branch' };
  }

  return {
    target: {
      worktreePath: canonicalPath(worktreePath),
      commonDir: canonicalPath(commonDir),
      gitDir: canonicalPath(gitDir),
      head: entry.head,
      ...(entry.branch ? { branch: entry.branch } : {}),
      detached: entry.detached,
      bare: false,
    },
  };
}

/**
 * Return the first hard-stop reason for a removal target. The protected branch
 * check is derived from the current registry entry; the caller's branch is
 * retained only for compatibility and logging at call sites.
 */
export async function getWorktreeRemovalGuardReason(
  worktreePath: string,
  options: WorktreeRemovalGuardOptions = {},
): Promise<WorktreeRemovalGuardReason | undefined> {
  return (await inspectWorktreeRemovalTarget(worktreePath, options)).reason;
}

const removalLocks = new Map<string, Promise<void>>();

function matchesExpectedHead(actual: string, expected: string): boolean {
  return expected.length >= 7
    ? actual === expected || actual.startsWith(expected)
    : actual === expected;
}

async function withRemovalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = removalLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  removalLocks.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (removalLocks.get(key) === current) removalLocks.delete(key);
  }
}

/** Remove an exact registered linked worktree through Git's own command. */
export async function removeRegisteredWorktree(
  worktreePath: string,
  options: RemoveRegisteredWorktreeOptions = {},
): Promise<RemoveRegisteredWorktreeResult> {
  // Classify obvious non-worktree paths before resolving repository context so
  // legacy reflection cleanup can distinguish a plain disposable directory
  // from a Git context failure. A bare repository still reports as primary
  // here, even though it has no `.git` child.
  if (await isPrimaryWorkingTree(worktreePath)) {
    return { removed: false, reason: 'primary-working-tree' };
  }
  if (!looksLikeLinkedWorktree(worktreePath)) {
    return { removed: false, reason: 'not-a-linked-worktree' };
  }

  const commonDir = await resolveWorktreeCommonDir(worktreePath);
  if (!commonDir) return { removed: false, reason: 'repository-context-unavailable' };

  return withRemovalLock(canonicalPath(commonDir), async () => {
    const inspection = await inspectWorktreeRemovalTarget(worktreePath, options);
    if (inspection.reason) return { removed: false, reason: inspection.reason };
    const target = inspection.target;
    if (!target) return { removed: false, reason: 'not-a-linked-worktree' };

    if (
      (options.expectedHead !== undefined && !matchesExpectedHead(target.head, options.expectedHead))
      || (options.expectedBranch !== undefined && options.expectedBranch !== target.branch)
      || (options.expectedDetached !== undefined && options.expectedDetached !== target.detached)
      || (options.expectedGitDir !== undefined && !samePath(options.expectedGitDir, target.gitDir))
    ) {
      return { removed: false, reason: 'worktree-identity-changed', target };
    }

    const args = ['-C', target.commonDir, 'worktree', 'remove'];
    if (options.force) args.push('--force');
    args.push('--', target.worktreePath);
    const result = await runGitWithSignal(args, options.signal);
    if (!result.ok) {
      return {
        removed: false,
        reason: 'git-remove-failed',
        target,
        stderr: result.stderr,
      };
    }

    try {
      lstatSync(target.worktreePath);
      return {
        removed: false,
        reason: 'git-remove-failed',
        target,
        stderr: 'git worktree remove reported success but the path remains',
      };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
      if (code === 'ENOENT') return { removed: true, target };
      return {
        removed: false,
        reason: 'git-remove-failed',
        target,
        stderr: `worktree removal verification failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}
