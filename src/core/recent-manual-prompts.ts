import type { Task } from './task-read-model.js';
import { displayPromptForTask } from './prompt-display.js';
import {
  RECENT_PROMPTS_MAX_LIMIT,
  type RecentPromptEntry,
} from '../shared/contracts/recent-prompts.js';

/** The task fields the projection reads. Keeps callers from passing whole stores. */
export type RecentPromptTask = Pick<
  Task,
  'prompt' | 'userPrompt' | 'cwd' | 'createdAt' | 'provenance'
>;

export interface SelectRecentManualPromptsOptions {
  /** Working directory to prioritize. When set, prompts ever launched there rank first. */
  cwd?: string;
  /** Max entries to return. Clamped to `[0, RECENT_PROMPTS_MAX_LIMIT]`. */
  limit: number;
  /**
   * Canonicalize a working directory before comparison. The server injects
   * `canonicalizeCwd` (realpath + resolve) so trailing-slash / `~` / symlink /
   * relative variants match; the default here is a light normalizer so this pure
   * function stays testable without a filesystem.
   */
  normalizeCwd?: (cwd: string) => string;
}

/** Default cwd normalizer: trim and drop trailing slashes. No filesystem access. */
function defaultNormalizeCwd(cwd: string): string {
  return cwd.trim().replace(/\/+$/, '');
}

interface PromptGroup {
  prompt: string;
  cwd: string;
  at: number;
  cwdMatch: boolean;
}

/**
 * Project a task list into the recent manual-launch prompts for the Launch
 * dialog's recall picker (RFC: rfc-launch-prompt-recall).
 *
 * Pure and read-only — it never mutates or retains the input tasks, so the caller
 * may pass a non-cloning store read (`viewTasks()`), and it takes both live and
 * archived tasks concatenated (dedup handles any overlap).
 *
 * Algorithm (order matters — ranking is computed over ALL occurrences BEFORE the
 * cap, so a prompt run many times in repo A but once, most recently, in repo B is
 * still ranked into repo A's group when A is the query cwd, rather than being
 * homed at B and evicted):
 *  1. keep `provenance.kind === 'manual'` tasks with a non-empty display prompt,
 *  2. sort by `createdAt` descending,
 *  3. group by display text; per group keep the most-recent occurrence for
 *     `cwd`/`at`, and set `cwdMatch` if ANY occurrence's canonical cwd equals the
 *     canonical query cwd,
 *  4. stable-partition `cwdMatch` first (each partition stays recency-ordered),
 *  5. cap at `limit`.
 */
export function selectRecentManualPrompts(
  tasks: readonly RecentPromptTask[],
  options: SelectRecentManualPromptsOptions,
): RecentPromptEntry[] {
  const normalize = options.normalizeCwd ?? defaultNormalizeCwd;
  const cap = Math.min(Math.max(Math.floor(options.limit), 0), RECENT_PROMPTS_MAX_LIMIT);
  if (cap === 0) return [];

  const queryCwd = options.cwd?.trim() ? normalize(options.cwd) : undefined;

  const manual = tasks
    .filter((t) => t.provenance?.kind === 'manual')
    .map((t) => ({ task: t, prompt: displayPromptForTask(t).trim() }))
    .filter((entry) => entry.prompt.length > 0);

  // Descending by createdAt so the first occurrence seen per group is the newest.
  manual.sort((a, b) => b.task.createdAt.getTime() - a.task.createdAt.getTime());

  const groups = new Map<string, PromptGroup>();
  for (const { task, prompt } of manual) {
    const occurrenceMatches =
      queryCwd !== undefined && normalize(task.cwd) === queryCwd;
    const existing = groups.get(prompt);
    if (existing) {
      // Recency and display fields belong to the first (newest) occurrence;
      // cwdMatch accumulates across every occurrence of this prompt text.
      existing.cwdMatch = existing.cwdMatch || occurrenceMatches;
      continue;
    }
    groups.set(prompt, {
      prompt,
      cwd: task.cwd,
      at: task.createdAt.getTime(),
      cwdMatch: occurrenceMatches,
    });
  }

  // Insertion order is already recency order (newest occurrence inserted first).
  const ordered = [...groups.values()];
  const matched = ordered.filter((g) => g.cwdMatch);
  const rest = ordered.filter((g) => !g.cwdMatch);
  return [...matched, ...rest].slice(0, cap);
}
