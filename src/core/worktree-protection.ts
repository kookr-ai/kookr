import { resolve } from 'node:path';

/** Worktrees that Kookr must never remove automatically or from the workspace UI. */
export function isProtectedWorktreePath(worktreePath: string): boolean {
  return resolve(worktreePath).endsWith('kookr-prod');
}
