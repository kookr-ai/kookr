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

export type DeliveryPolicy = 'pre-authorized' | 'ask-first';

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

function deliveryGateSentence(deliveryPolicy: DeliveryPolicy): string {
  if (deliveryPolicy === 'pre-authorized') {
    return 'Delivery is pre-authorized for this task: when your work is committed and verified, finish the full delivery cycle without asking again — commit, push the branch, open or update the PR, and report the PR URL. If you show a diff or plan and the user approves it, treat that as approval to continue through the full delivery cycle. The PR is the review gate. If the work does not actually satisfy the task, do NOT open a PR; stop and report what\'s wrong instead.';
  }
  return "After committing, don't end your turn silently — unless the task already told you to deliver, ask the user whether to push the branch and open a PR.";
}

async function resolveRemoteWorktreeBase(cwd: string): Promise<string | null> {
  const originHead = await gitIn(cwd, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  if (originHead?.startsWith('origin/')) return originHead;

  for (const candidate of ['origin/main', 'origin/staging', 'origin/master']) {
    const sha = await gitIn(cwd, 'rev-parse', '--verify', '--quiet', candidate);
    if (sha) return candidate;
  }

  return null;
}

function remoteBranchName(baseRef: string): string | null {
  return baseRef.startsWith('origin/') ? baseRef.slice('origin/'.length) : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildGuidance(
  context: CheckoutContext,
  branchLabel: string,
  repoName: string,
  worktreeBaseRef: string | null,
  deliveryPolicy: DeliveryPolicy,
): string {
  const branchPhrase = describeBranch(branchLabel);
  const here = context.isWorktree
    ? `You are currently in the git worktree \`${context.topLevel}\` ${branchPhrase}. The main checkout is at \`${context.repoRoot}\`.`
    : `You are currently in the main checkout \`${context.repoRoot}\` ${branchPhrase}.`;
  const noCommitTarget = context.isWorktree
    ? 'Do NOT commit to main, in this worktree, or in the main checkout'
    : 'Do NOT commit to main or in this checkout';
  const baseRef = worktreeBaseRef ?? 'HEAD';
  const remoteBranch = worktreeBaseRef ? remoteBranchName(worktreeBaseRef) : null;
  const guidance = [
    `${here} ${noCommitTarget} — every Kookr task must make tracked-file changes in a fresh git worktree of its own, not in any pre-existing checkout (the main repo, the production runtime worktree, or any sibling worktree spawned for unrelated work).`,
  ];
  if (remoteBranch) {
    guidance.push(`- Refresh the remote base first: \`git fetch origin ${shellQuote(remoteBranch)}\`.`);
  }
  guidance.push(
    `- Create one: \`git worktree add ../${repoName}-<short-name> -b <feature-branch> ${shellQuote(baseRef)}\``,
    `- Perform all tracked-file edits, commits, and pushes from that new worktree.`,
    `- If the task stays read-only, you may remain in the current checkout.`,
    `- ${deliveryGateSentence(deliveryPolicy)}`,
  );
  return guidance.join('\n');
}

export async function applyWorktreeGuardrails(
  prompt: string,
  cwd: string,
  deliveryPolicy: DeliveryPolicy = 'ask-first',
): Promise<string> {
  if (!prompt.trim() || hasWorktreeGuardrails(prompt)) return prompt;

  const context = await getCheckoutContext(cwd);
  if (!context) return prompt;

  const branchLabel = await readBranchLabel(cwd);
  const worktreeBaseRef = await resolveRemoteWorktreeBase(cwd);
  const repoName = basename(context.repoRoot) || 'repo';
  const guidance = buildGuidance(context, branchLabel, repoName, worktreeBaseRef, deliveryPolicy);
  return `${guidance}\n\n${prompt}`;
}
