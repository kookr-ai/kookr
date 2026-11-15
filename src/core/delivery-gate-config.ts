/**
 * Integration-branch reader, the TypeScript twin of
 * `delivery_gate_integration_branch` in scripts/lib/delivery-gate.sh (#3788).
 *
 * When a repository has `.kookr/delivery-gate.json` with an
 * `integrationBranch`, pull requests merge into that branch and the
 * integration train later fast-forwards `main` to verified commits. Code that
 * asks "did this PR merge?" should then accept the integration branch; code
 * that asks "is this change verified?" keeps asking `main`.
 *
 * As in the shell reader, the copy on `origin/main` wins; the working tree is
 * read only when `origin/main` does not exist. Nothing is cached, so deleting
 * the file on `main` turns the feature off at the next fetch.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseIntegrationBranch, TRAIN_TARGET_BRANCH } from './integration-branch.js';

const execFileAsync = promisify(execFile);

export { parseIntegrationBranch, TRAIN_TARGET_BRANCH };

export type GitRunner = (args: string[], cwd: string) => Promise<{ ok: boolean; stdout: string }>;

const defaultGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
};

/**
 * The integration branch configured for the repository at `repoPath`, or null
 * when none is configured or anything cannot be read (the legacy behaviour).
 */
export async function readIntegrationBranch(repoPath: string, git: GitRunner = defaultGit): Promise<string | null> {
  const hasMain = await git(['rev-parse', '--verify', '--quiet', `origin/${TRAIN_TARGET_BRANCH}`], repoPath);
  if (hasMain.ok) {
    const shown = await git(['show', `origin/${TRAIN_TARGET_BRANCH}:.kookr/delivery-gate.json`], repoPath);
    return shown.ok ? parseIntegrationBranch(shown.stdout) : null;
  }
  const root = await git(['rev-parse', '--show-toplevel'], repoPath);
  if (!root.ok || root.stdout.trim() === '') return null;
  try {
    return parseIntegrationBranch(await readFile(path.join(root.stdout.trim(), '.kookr', 'delivery-gate.json'), 'utf-8'));
  } catch {
    return null;
  }
}
