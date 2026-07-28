import type { Task } from './task-read-model.js';

// The worktree-guardrail preamble that `applyWorktreeGuardrails`
// (server/worktree-guardrails.ts) prepends to a launched prompt: an opening
// "You are currently in the (main checkout|git worktree) `…`" line, one or
// more "- " guidance bullets, then a blank line separating it from the real
// prompt body. Kept intentionally structural (anchor line + bullet block +
// blank line) rather than pinned to the exact wording of each bullet, so it
// keeps matching as the guidance copy evolves — an earlier version enumerated
// every bullet verbatim and silently stopped stripping once a new bullet
// ("When an investigation…") was added (issue #1556).
const WORKTREE_GUARDRAIL_PREFIX_RE =
  /^You are currently in the (?:main checkout|git worktree) `[^\n]*\n(?:[-*] [^\n]*\n)+\n([\s\S]*)$/;

/**
 * Strip the worktree-guardrail preamble from a prompt-like string, returning
 * the real body. Returns the input unchanged when no guardrail prefix is
 * present. Used both for display and as the first step of deterministic task
 * naming so guardrail boilerplate never leaks into a task name (issue #1556).
 */
export function stripWorktreeGuardrailPrefix(text: string): string {
  const match = WORKTREE_GUARDRAIL_PREFIX_RE.exec(text);
  return match?.[1] ?? text;
}

export function displayPromptForTask(task: Pick<Task, 'prompt' | 'userPrompt'>): string {
  // Prefer userPrompt, but strip the guardrail preamble from it too: a caller
  // that re-spawns a task by pasting an already-guarded prompt back in yields a
  // userPrompt that itself begins with the preamble (issue #1556, task
  // 447580f6). Falls back to parsing the legacy `task.prompt` for tasks
  // persisted before Task.userPrompt existed.
  const userPrompt = task.userPrompt?.trim();
  if (userPrompt) return stripWorktreeGuardrailPrefix(userPrompt).trim() || userPrompt;

  return stripWorktreeGuardrailPrefix(task.prompt).trim() || task.prompt;
}
