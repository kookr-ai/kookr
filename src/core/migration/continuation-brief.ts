/**
 * Cross-agent task migration — continuation brief builder
 * (RFC: rfc-cross-agent-task-migration).
 *
 * Reconstructs the prompt a NEW agent receives when it continues an interrupted
 * task's work. Assembled to be HONEST about attribution (round-1 consensus-attack
 * fix): the load-bearing content is the task's INTENT plus its already-persisted
 * vendor-neutral completion digest — both genuinely tied to this task. The
 * working checkout is treated as *context*, not an attributable per-task
 * snapshot, because in practice tasks share long-lived checkouts. The brief
 * therefore never presents commit history as "what the interrupted agent did";
 * it reports only current uncommitted changes, and labels them as possibly
 * shared when the checkout is shared.
 */

import type { AgentType } from '../../shared/contracts/agent-types.js';
import type { CompletionDigest } from '../../shared/contracts/completion-digest.js';
import type { Task } from '../task-read-model.js';
import { gitIn } from '../git-helpers.js';

/** A human agent label for the brief. */
const AGENT_LABELS: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'grok-build': 'Grok Build',
};

export interface WorktreeState {
  /** Whether `cwd` is a usable git repo. */
  isGitRepo: boolean;
  /** Uncommitted `git status --porcelain` lines (bounded), when a repo. */
  uncommitted: string[];
  /** Current branch (advisory context only), when resolvable. */
  branch?: string;
  /** True when this checkout is shared by other tasks / is not a dedicated worktree. */
  shared: boolean;
}

const MAX_UNCOMMITTED_LINES = 40;
const MAX_DIGEST_BULLETS = 6;

/**
 * Read a bounded, read-only snapshot of the working tree. Never throws; on any
 * git failure it degrades to `isGitRepo: false`. Reused `gitIn` applies the
 * repo's subprocess guards (timeout, maxBuffer, sanitized env).
 */
export async function readWorktreeState(cwd: string, shared: boolean): Promise<WorktreeState> {
  const branch = (await gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')) ?? undefined;
  const status = await gitIn(cwd, 'status', '--porcelain');
  if (status === null) {
    return { isGitRepo: false, uncommitted: [], shared, ...(branch ? { branch } : {}) };
  }
  const uncommitted = status
    ? status.split('\n').filter((l) => l.trim().length > 0).slice(0, MAX_UNCOMMITTED_LINES)
    : [];
  return { isGitRepo: true, uncommitted, shared, ...(branch ? { branch } : {}) };
}

function renderDigest(digest: CompletionDigest | undefined): string | null {
  if (!digest) return null;
  const parts: string[] = [];
  if (digest.bullets?.length) {
    parts.push(
      'What the previous agent recorded doing:\n' +
        digest.bullets.slice(0, MAX_DIGEST_BULLETS).map((b) => `  - ${b}`).join('\n'),
    );
  }
  if (digest.testSummary) parts.push(`Last test summary: ${digest.testSummary}`);
  if (digest.verificationCommands?.length) {
    parts.push(`Verification commands it ran: ${digest.verificationCommands.slice(0, 6).join('; ')}`);
  }
  if (digest.prUrls?.length) parts.push(`Related PR(s): ${digest.prUrls.join(', ')}`);
  return parts.length ? parts.join('\n') : null;
}

function renderWorktree(state: WorktreeState): string {
  if (!state.isGitRepo) {
    return 'Working directory is not a clean git checkout — assess the working tree before editing.';
  }
  const header = state.shared
    ? 'Uncommitted changes currently in this checkout (NOTE: this is a shared checkout used by ' +
      'other tasks — these changes may include unrelated in-progress work; verify what belongs to ' +
      'this task before assuming or modifying it):'
    : 'Uncommitted changes currently in this checkout:';
  if (state.uncommitted.length === 0) {
    return state.shared
      ? 'The shared checkout currently has no uncommitted changes.'
      : 'The checkout currently has no uncommitted changes.';
  }
  return `${header}\n${state.uncommitted.map((l) => `  ${l}`).join('\n')}`;
}

export interface ContinuationBriefInput {
  task: Task;
  targetAgent: AgentType;
  worktree: WorktreeState;
}

/**
 * Build the continuation brief. Intent + digest lead; working-tree state is
 * honest context. Delivered to the new agent via the adapters' post-start input
 * mechanism (never on argv).
 */
export function buildContinuationBrief(input: ContinuationBriefInput): string {
  const { task, targetAgent, worktree } = input;
  const fromLabel = AGENT_LABELS[task.agentType] ?? task.agentType;
  const toLabel = AGENT_LABELS[targetAgent] ?? targetAgent;
  const intent = (task.userPrompt ?? task.prompt ?? '').trim();
  const criteria = task.criteria?.trim();
  const digest = renderDigest(task.completionDigest);

  const sections: string[] = [
    `You are CONTINUING an interrupted task under a new agent — you are ${toLabel}. ` +
      `The previous agent (${fromLabel}) was interrupted (its provider became unavailable) ` +
      `before finishing. Continue this task's original objective. Assess the current state of ` +
      `the working directory before making any changes.`,
    `Original request:\n${intent}`,
  ];
  if (criteria) sections.push(`Acceptance criteria:\n${criteria}`);
  if (digest) sections.push(digest);
  sections.push(renderWorktree(worktree));
  sections.push(
    'Start by determining what still needs to be done to satisfy the original request, then ' +
      'complete it. Do not restart work that is already correctly done.',
  );
  return sections.join('\n\n');
}
