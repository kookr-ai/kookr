import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitInfo } from '../core/types.js';

export type { GitInfo };

/**
 * Read git info from a directory via filesystem (no git CLI needed).
 * Returns null if the directory is not a git repository.
 */
export async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  const gitPath = join(cwd, '.git');

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
    headPath = join(match[1].trim(), 'HEAD');
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
        ? join(cwd, '.git') // For worktrees, the ref might be in the main repo
        : gitPath;
      // For worktrees, we need the common dir. Read the actual gitdir to find the main .git
      let refBase: string;
      if (isWorktree) {
        const gitFileContent = await readFile(gitPath, 'utf-8');
        const dirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/m);
        if (dirMatch) {
          // gitdir points to .git/worktrees/name, go up to .git
          const worktreeGitDir = dirMatch[1].trim();
          const commonDir = join(worktreeGitDir, '..', '..');
          refBase = commonDir;
        } else {
          refBase = gitDir;
        }
      } else {
        refBase = gitDir;
      }
      const refPath = join(refBase, 'refs', 'heads', branch);
      const sha = (await readFile(refPath, 'utf-8')).trim();
      commit = sha.slice(0, 7);
    } catch {
      // Packed refs or other edge case — commit stays null
    }
    return { branch, commit, isWorktree, isDetached: false };
  }

  // Detached HEAD — headContent is a raw SHA
  const commit = headContent.slice(0, 7);
  return { branch: null, commit, isWorktree, isDetached: true };
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
