import type { AgentSelection } from './contracts/agent-types.js';

/**
 * Client-side duplicate-launch match — same equality `kookr spawn` uses
 * (`taskMatchesSpawn` in `bin/kookr-spawn.js`).
 *
 * A match is an *active* task (not completed / cancelled / terminated) with
 * the same working directory and the same authored prompt. Agent type is
 * compared only when the new launch pinned a concrete agent; `round-robin`
 * is treated as unpinned because no stored task carries that sentinel.
 *
 * Trailing slashes on cwd are ignored (`/repo` ≡ `/repo/`). The dashboard
 * snapshot stores the authored prompt as `description` (or `userPrompt` on
 * the full task record). `prompt` is a suffix/prefix fallback for older
 * records that only kept the injected launch body.
 */

/** Two cwds are equivalent if they differ only by trailing slashes. */
export function cwdEquivalent(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export interface LaunchDuplicateCandidate {
  id?: string;
  taskId?: string;
  agentId?: string;
  status?: string | null;
  taskStatus?: string | null;
  cwd?: string | null;
  agentType?: string | null;
  userPrompt?: string | null;
  prompt?: string | null;
  description?: string | null;
  taskName?: string | null;
}

export interface LaunchDuplicateQuery {
  prompt: string;
  cwd: string;
  agentType?: AgentSelection | string | null;
}

/** Same terminal set `kookr spawn` uses (`TERMINAL_TASK_STATUSES`). */
function isTerminalLaunchStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'terminated';
}

function promptMatches(task: LaunchDuplicateCandidate, prompt: string): boolean {
  const authored = typeof task.userPrompt === 'string' ? task.userPrompt : null;
  if (authored !== null && (authored === prompt || authored.trim() === prompt)) return true;

  // Dashboard snapshot: `description` is displayPromptForTask (userPrompt,
  // guardrails stripped). Treat it like the CLI's userPrompt field.
  const description = typeof task.description === 'string' ? task.description : null;
  if (description !== null && (description === prompt || description.trim() === prompt)) return true;

  const raw = typeof task.prompt === 'string' ? task.prompt : null;
  if (raw !== null) {
    if (raw === prompt || raw.trim() === prompt) return true;
    if (raw.startsWith(prompt) || raw.endsWith(prompt)) return true;
  }
  return false;
}

/**
 * Does an existing task look like the launch the operator is about to send?
 * Mirrors `taskMatchesSpawn` in `bin/kookr-spawn.js`.
 */
export function taskMatchesLaunchDuplicate(
  task: LaunchDuplicateCandidate,
  query: LaunchDuplicateQuery,
): boolean {
  if (!task || typeof task !== 'object') return false;
  const status = typeof (task.taskStatus ?? task.status) === 'string'
    ? (task.taskStatus ?? task.status)
    : null;
  if (status && isTerminalLaunchStatus(status)) return false;
  if (!cwdEquivalent(task.cwd, query.cwd)) return false;
  const pinned = query.agentType && query.agentType !== 'round-robin' ? query.agentType : null;
  if (pinned && typeof task.agentType === 'string' && task.agentType !== pinned) return false;
  return promptMatches(task, query.prompt);
}

/**
 * First active task in `tasks` that matches prompt + cwd + (optional) agent.
 * Empty prompt or cwd never matches — the launch form is incomplete.
 */
export function findActiveLaunchDuplicate(
  tasks: readonly LaunchDuplicateCandidate[],
  query: LaunchDuplicateQuery,
): LaunchDuplicateCandidate | undefined {
  const prompt = query.prompt.trim();
  const cwd = query.cwd.trim();
  if (!prompt || !cwd) return undefined;
  return tasks.find((task) => taskMatchesLaunchDuplicate(task, { ...query, prompt, cwd }));
}
