/**
 * Shared git subprocess helpers.
 *
 * Thin wrappers around execFile for running git commands.
 * Used by repo-policy-resolver and cleanup-inspector.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

/** Run a git command in a specific directory and return trimmed stdout, or null on failure. */
export async function gitIn(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    // Strip GIT_DIR/GIT_WORK_TREE so the cwd is authoritative.
    // These vars leak from git hooks (e.g. pre-push) and override --work-tree/cwd.
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const { stdout } = await execFileAsync('git', args, { cwd, env });
    return stdout.trim();
  } catch {
    return null;
  }
}
