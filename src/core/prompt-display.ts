import type { Task } from './task-read-model.js';

import { stripWorktreeGuardrailPrefix } from '../shared/task-name-display.js';

export { stripWorktreeGuardrailPrefix };

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
