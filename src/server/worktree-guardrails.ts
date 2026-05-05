import { basename, dirname, resolve } from 'node:path';
import { gitIn } from '../core/git-helpers.js';

const WORKTREE_GUARD_SENTINELS = [
  /git\s+worktree\s+add/i,
  /do not commit to main/i,
  /do not commit to the main checkout/i,
  /do not commit (?:in|to) (?:this|the current) (?:checkout|worktree|directory)/i,
];

function hasWorktreeGuardrails(prompt: string): boolean {
  return WORKTREE_GUARD_SENTINELS.some((pattern) => pattern.test(prompt));
}

interface CheckoutContext {
  /** Filesystem path of the main checkout (the repo root containing the .git dir). */
  repoRoot: string;
  /** Filesystem path of the current working tree (toplevel). Equals repoRoot for the main checkout. */
  topLevel: string;
  /** True when topLevel differs from repoRoot — i.e. cwd is a linked worktree. */
  isWorktree: boolean;
}

async function getCheckoutContext(cwd: string): Promise<CheckoutContext | null> {
  const toplevel = await gitIn(cwd, 'rev-parse', '--show-toplevel');
  if (!toplevel) return null;

  const resolvedTopLevel = resolve(toplevel.trim());
  const commonDir = await gitIn(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!commonDir) {
    return { repoRoot: resolvedTopLevel, topLevel: resolvedTopLevel, isWorktree: false };
  }

  const trimmedCommonDir = resolve(commonDir.trim());
  const repoRoot = basename(trimmedCommonDir) === '.git'
    ? resolve(dirname(trimmedCommonDir))
    : trimmedCommonDir;

  return {
    repoRoot,
    topLevel: resolvedTopLevel,
    isWorktree: repoRoot !== resolvedTopLevel,
  };
}

async function readBranchLabel(cwd: string): Promise<string> {
  const branch = await gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch || branch === 'HEAD') return 'detached HEAD';
  return branch;
}

function describeBranch(branchLabel: string): string {
  return branchLabel === 'detached HEAD' ? '(detached HEAD)' : `on branch \`${branchLabel}\``;
}

function buildGuidance(context: CheckoutContext, branchLabel: string, repoName: string): string {
  const branchPhrase = describeBranch(branchLabel);
  const here = context.isWorktree
    ? `You are currently in the git worktree \`${context.topLevel}\` ${branchPhrase}. The main checkout is at \`${context.repoRoot}\`.`
    : `You are currently in the main checkout \`${context.repoRoot}\` ${branchPhrase}.`;
  const noCommitTarget = context.isWorktree
    ? 'Do NOT commit in this worktree or in the main checkout'
    : 'Do NOT commit in this checkout';
  return [
    `${here} ${noCommitTarget} — every Kookr task must make tracked-file changes in a fresh git worktree of its own, not in any pre-existing checkout (the main repo, the production runtime worktree, or any sibling worktree spawned for unrelated work).`,
    `- Create one: \`git worktree add ../${repoName}-<short-name> -b <feature-branch> HEAD\``,
    `- Perform all tracked-file edits, commits, and pushes from that new worktree.`,
    `- If the task stays read-only, you may remain in the current checkout.`,
  ].join('\n');
}

export async function applyWorktreeGuardrails(prompt: string, cwd: string): Promise<string> {
  if (!prompt.trim() || hasWorktreeGuardrails(prompt)) return prompt;

  const context = await getCheckoutContext(cwd);
  if (!context) return prompt;

  const branchLabel = await readBranchLabel(cwd);
  const repoName = basename(context.repoRoot) || 'repo';
  const guidance = buildGuidance(context, branchLabel, repoName);
  return `${guidance}\n\n${prompt}`;
}
