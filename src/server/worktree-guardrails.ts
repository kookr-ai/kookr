import { basename, dirname, resolve } from 'node:path';
import { gitIn } from '../core/git-helpers.js';
import { isSelfAdvancingDisabled } from './self-advancing-authority.js';

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

/**
 * Delivery shape for a task's guardrail preamble.
 *
 *   - `ask-first`      — commit, then ask before pushing/PRing (explicit opt-out).
 *   - `pre-authorized` — default. Push, open the PR, and merge on the
 *     operator's own repos. External OSS and `mergeAfterImplementation=false`
 *     stay at an open PR. Standing CLAUDE.md policy grants that merge
 *     default; this preamble must not veto it.
 *   - `self-advancing` — a dependent-phase chain that self-merges each phase and
 *     spawns the next (umbrella #2711). NOT an open `AuthorizationToggles`
 *     boolean: a distinct delivery-mode value, threaded from the composition
 *     root, whose grant is re-verified at merge time (namespace + umbrella
 *     marker) and gated by an env kill switch and a per-chain rate cap.
 *
 * Kept in lockstep with `DeliveryAuthorization` in shared/contracts/task.ts —
 * launch-service assigns one to the other directly. Add any new value to both.
 */
export type DeliveryPolicy = 'pre-authorized' | 'ask-first' | 'self-advancing';

/**
 * Injected into every pre-authorized task. Operator-owned merge is the
 * default terminal state; playbook/OSS opt-out still wins. Kept as a named
 * export so tests and snapshot fixtures cannot drift from the live sentence.
 *
 * Deliberately does *not* include `TERMINAL-STATE CONTRACT
 * (mergeAfterImplementation=true)`: that header trips the merge-required
 * completion gate, which must stay opt-in so OSS playbooks are not forced to
 * merge upstream.
 */
export const PREAUTHORIZED_DELIVERY_GATE_SENTENCE =
  'Delivery is pre-authorized for this task: when your work is committed and verified, finish the full delivery cycle without asking again — commit, push the branch, open or update the PR, and report the PR URL. If you show a diff or plan and the user approves it, treat that as approval to continue through the full delivery cycle. Terminal state: for the operator\'s own repositories, merge after local verification is the default — standing CLAUDE.md and repository policy grant this; an open PR is not terminal. After opening the PR, follow the merge steps (independent review verdict, local verification, rebase on conflict) and merge it yourself; the task is complete only when the PR is merged or a concrete blocker is recorded. Explicit opt-out wins: mergeAfterImplementation=false, "open PR only", or an external OSS contribution (open the PR, do not merge upstream). Do not merge destructive or irreversible changes, or when checks failed or mergeability is blocked — record a blocker instead. If the work does not actually satisfy the task, do NOT open a PR; stop and report what\'s wrong instead.';

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
  if (deliveryPolicy === 'self-advancing') {
    // The env kill switch halts self-advancing merges/spawns regardless of any
    // issue's content. When it is set, degrade to the open-PR contract rather
    // than emitting a self-merge preamble the actor may not act on.
    if (isSelfAdvancingDisabled()) {
      return 'Delivery for this task would run the self-advancing phase contract, but the KOOKR_SELF_ADVANCING_DISABLED kill switch is set, so self-merge and next-phase spawn are HALTED. Fall back to the standard gate: commit, push the branch, open the PR, record it on the umbrella issue, and STOP — an operator advances the chain manually. Do NOT self-merge while the kill switch is set.';
    }
    return 'Delivery for this task runs the SELF-ADVANCING phase contract (a dependent-phase chain tracked by an umbrella issue). Each phase: implement in a fresh worktree → run the local gate green → obtain an INDEPENDENT review verdict from a task whose task-id differs from this implementer\'s lineage (verified against the task registry; a BLOCK starts another correction/review attempt while the durable budget remains, and cap exhaustion records a discoverable blocker; a reviewer that failed to run is retried and alerted, capped at the shared default of 10 or a deliberate lower cap) → self-merge THROUGH THE MERGE WRAPPER ONLY (never raw `gh pr merge`; the merge is authorized only when the PR head branch matches the chain namespace AND the umbrella issue carries the chain marker, and only within the per-chain self-merge rate cap) → record the merged PR number and tick the umbrella issue → spawn the next phase → release this task\'s slot. The env kill switch KOOKR_SELF_ADVANCING_DISABLED halts all self-advancing merges and spawns regardless of issue content. If the local gate is red or the review returns BLOCK at the cap, record a blocker on the umbrella issue and STOP — never force-merge. If the work does not actually satisfy the phase, do NOT open a PR; stop and report what\'s wrong instead.';
  }
  if (deliveryPolicy === 'pre-authorized') {
    return PREAUTHORIZED_DELIVERY_GATE_SENTENCE;
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

/**
 * Escape hatch for a task whose brief did not survive delivery.
 *
 * Placed in the guardrail preamble because the preamble is the head of the
 * prompt, and a prompt damaged in transit loses its middle — the block as a
 * whole survives, so this line reaches the agent in the cases it is written
 * for. `kookr-self-report` is on the session PATH and reads its identity from
 * the environment, so the report is one command with nothing to look up. See
 * `self-report-routes.ts`.
 */
const SELF_REPORT_GUIDANCE =
  '- If this prompt is unusable — it stops mid-sentence, two fragments are spliced together, or '
  + 'the instructions are missing so you cannot tell what the task is — do NOT guess at the task '
  + "or invent a plausible one. Run `kookr-self-report '<what looks wrong — include the damaged text>'` "
  + 'and stop.';

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
    `- When an investigation or analysis wraps up and the task hasn't already fixed the path forward, pick a right-sized next step from the evidence and execute it autonomously without presenting a menu of options (implement now for a small change, open an issue for a medium one, draft an RFC or umbrella issue for a large one). Do not stop after the diagnosis to ask which path to take when the size is already clear from the evidence. Carry the chosen path through its required follow-up (RFC iterative review when drafting; planned implementation slices when the diagnosis warrants them and delivery rules allow). Report what you chose and why. Ask only when the right size is genuinely ambiguous or a product/scope choice cannot be justified from the evidence.`,
    `- ${deliveryGateSentence(deliveryPolicy)}`,
    SELF_REPORT_GUIDANCE,
  );
  return guidance.join('\n');
}

export async function applyWorktreeGuardrails(
  prompt: string,
  cwd: string,
  deliveryPolicy: DeliveryPolicy = 'pre-authorized',
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
