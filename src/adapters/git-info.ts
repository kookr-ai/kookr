import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { GitInfo } from '../core/types.js';
import type { WorktreeRegistry } from './git-worktree-registry.js';

export type { GitInfo };

/**
 * Read git info from a directory via filesystem (no git CLI needed).
 * Returns null if the directory is not a git repository.
 */
export async function getGitInfo(cwd: string, registry?: Pick<WorktreeRegistry, 'byPath'>): Promise<GitInfo | null> {
  const registryEntry = registry?.byPath(cwd);
  if (registryEntry) {
    return {
      branch: registryEntry.branch,
      commit: registryEntry.head.slice(0, 7),
      isWorktree: !registryEntry.isMain,
      isDetached: registryEntry.isDetached,
      worktreeRoot: registryEntry.path,
    };
  }

  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) return null;
  const gitPath = join(gitRoot, '.git');
  const registryRootEntry = registry?.byPath(gitRoot);
  if (registryRootEntry) {
    return {
      branch: registryRootEntry.branch,
      commit: registryRootEntry.head.slice(0, 7),
      isWorktree: !registryRootEntry.isMain,
      isDetached: registryRootEntry.isDetached,
      worktreeRoot: registryRootEntry.path,
    };
  }

  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    return null; // Not a git repo
  }

  let headPath: string;
  let isWorktree = false;

  if (gitStat.isFile()) {
    // Worktree: .git is a file containing "gitdir: /path/to/.git/worktrees/name"
    const content = await readFile(gitPath, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    const worktreeGitDir = resolveGitFilePath(gitRoot, match[1].trim());
    headPath = join(worktreeGitDir, 'HEAD');
    isWorktree = true;
  } else {
    headPath = join(gitPath, 'HEAD');
  }

  let headContent: string;
  try {
    headContent = (await readFile(headPath, 'utf-8')).trim();
  } catch {
    return null;
  }

  // Parse HEAD: "ref: refs/heads/branch-name" or raw SHA
  const refMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (refMatch) {
    // On a branch — resolve the ref to get the commit
    const branch = refMatch[1];
    let commit: string | null = null;
    try {
      // Try to resolve the ref file for the short commit hash
      const gitDir = isWorktree
        ? join(gitRoot, '.git') // For worktrees, the ref might be in the main repo
        : gitPath;
      // For worktrees, we need the common dir. Read the actual gitdir to find the main .git
      let refBases: string[];
      if (isWorktree) {
        const gitFileContent = await readFile(gitPath, 'utf-8');
        const dirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/m);
        if (dirMatch) {
          // gitdir points to .git/worktrees/name, go up to .git
          const worktreeGitDir = resolveGitFilePath(gitRoot, dirMatch[1].trim());
          const commonDir = resolve(worktreeGitDir, '..', '..');
          refBases = [worktreeGitDir, commonDir];
        } else {
          refBases = [gitDir];
        }
      } else {
        refBases = [gitDir];
      }
      const sha = await readRefSha(refBases, `refs/heads/${branch}`);
      commit = sha.slice(0, 7);
    } catch {
      // Packed refs or other edge case — commit stays null
    }
    return { branch, commit, isWorktree, isDetached: false, worktreeRoot: gitRoot };
  }

  // Detached HEAD — headContent is a raw SHA
  const commit = headContent.slice(0, 7);
  return { branch: null, commit, isWorktree, isDetached: true, worktreeRoot: gitRoot };
}

/**
 * Check if a Bash tool input likely contains a git branch/checkout command.
 * Used as a lightweight trigger to re-read .git/HEAD — does not parse the branch name.
 */
export function isGitBranchCommand(toolInput: unknown): boolean {
  if (!toolInput || typeof toolInput !== 'object') return false;
  const command = (toolInput as { command?: string }).command ?? '';
  return /\bgit\s+(checkout|switch|worktree)\b/.test(command);
}

async function findGitRoot(startPath: string): Promise<string | null> {
  let current = resolve(startPath);
  try {
    const startStat = await stat(current);
    if (!startStat.isDirectory()) current = dirname(current);
  } catch {
    current = dirname(current);
  }

  while (true) {
    try {
      const gitStat = await stat(join(current, '.git'));
      if (gitStat.isDirectory() || gitStat.isFile()) return current;
    } catch {
      // Keep walking.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveGitFilePath(worktreeRoot: string, gitdir: string): string {
  return resolve(worktreeRoot, gitdir);
}

async function readRefSha(refBases: string[], refName: string): Promise<string> {
  for (const refBase of refBases) {
    try {
      return (await readFile(join(refBase, refName), 'utf-8')).trim();
    } catch {
      // Try the next location.
    }
  }

  for (const refBase of refBases) {
    try {
      const packedRefs = await readFile(join(refBase, 'packed-refs'), 'utf-8');
      for (const line of packedRefs.split('\n')) {
        if (!line || line.startsWith('#') || line.startsWith('^')) continue;
        const [sha, name] = line.trim().split(/\s+/, 2);
        if (name === refName && /^[0-9a-f]{40}$/i.test(sha)) return sha;
      }
    } catch {
      // Try the next packed-refs file.
    }
  }

  throw new Error(`ref not found: ${refName}`);
}
