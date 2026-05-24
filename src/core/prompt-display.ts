import type { Task } from './task-read-model.js';

// Legacy fallback for tasks persisted before Task.userPrompt existed. New tasks
// should display userPrompt rather than parsing launch guidance out of prompt.
const WORKTREE_GUARDRAIL_PREFIX_RE = /^(?:You are currently in the (?:main checkout|git worktree) `[^`]+`[^\n]*\n- Create one: `git worktree add [^\n]+`\n- Perform all tracked-file edits, commits, and pushes from that new worktree\.\n- If the task stays read-only, you may remain in the current checkout\.\n- After committing, don't end your turn silently [^\n]+\n\n)([\s\S]*)$/;

export function displayPromptForTask(task: Pick<Task, 'prompt' | 'userPrompt'>): string {
  const userPrompt = task.userPrompt?.trim();
  if (userPrompt) return userPrompt;

  const match = WORKTREE_GUARDRAIL_PREFIX_RE.exec(task.prompt);
  return match?.[1]?.trim() || task.prompt;
}
