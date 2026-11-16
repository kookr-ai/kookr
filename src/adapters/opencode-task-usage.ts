/**
 * A task's opencode token usage across launches (#3527), shared by the TUI and container adapters.
 *
 * Both adapters keep one opencode DB per task (see opencode-task-data.ts). A fresh launch wipes that DB, so the
 * DB alone only knows the current conversation. Before the wipe, the usage the task has spent so far is written
 * beside the new DB as a baseline, and the task's recorded usage is always baseline + DB total. The baseline lives
 * in the task dir, so a resume of the same DB (also after a Kookr restart) reuses it and nothing is counted twice.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskStore } from '../core/tasks.js';
import type { TokenUsage } from '../core/usage-types.js';
import { isMarkedTaskDir, openCodeTaskDataHome } from './opencode-task-data.js';
import { mapOpenCodeUsageToTokenUsage, readOpenCodeDataHomeUsage } from './opencode-usage-scanner.js';

const USAGE_BASELINE_FILE = 'usage-baseline.json';
const USAGE_COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const;

const usageCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

function addTokenUsage(base: TokenUsage | undefined, current: TokenUsage): TokenUsage {
  if (!base) return current;
  return {
    ...base,
    ...current,
    inputTokens: usageCount(base.inputTokens) + usageCount(current.inputTokens),
    outputTokens: usageCount(base.outputTokens) + usageCount(current.outputTokens),
    cacheReadTokens: usageCount(base.cacheReadTokens) + usageCount(current.cacheReadTokens),
    cacheWriteTokens: usageCount(base.cacheWriteTokens) + usageCount(current.cacheWriteTokens),
    costUsd: usageCount(base.costUsd) + usageCount(current.costUsd),
  };
}

/** True when `a` is at least `b` on every counter (it lost nothing `b` had). */
function usageCovers(a: TokenUsage, b: TokenUsage): boolean {
  return USAGE_COUNTERS.every((k) => usageCount(a[k]) >= usageCount(b[k]));
}

async function readUsageBaseline(taskDir: string): Promise<TokenUsage | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(taskDir, USAGE_BASELINE_FILE), 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    return {
      inputTokens: usageCount(r.inputTokens),
      outputTokens: usageCount(r.outputTokens),
      cacheReadTokens: usageCount(r.cacheReadTokens),
      cacheWriteTokens: usageCount(r.cacheWriteTokens),
      costUsd: usageCount(r.costUsd),
      ...(typeof r.model === 'string' ? { model: r.model } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Record the usage carried into a freshly created DB. Call after the task dir is (re)created and marked. */
export async function writeUsageBaseline(taskDir: string, usage: TokenUsage): Promise<void> {
  try {
    await writeFile(join(taskDir, USAGE_BASELINE_FILE), `${JSON.stringify(usage)}\n`, { mode: 0o600 });
  } catch {
    /* best-effort: without it the next record counts only the current DB (the pre-#3527 behaviour) */
  }
}

/**
 * Store `total` as the task's usage unless it would lower a counter already recorded: baseline + DB only grows,
 * so a smaller total means the baseline file was lost, and recording it would undercount (and lower lifetime
 * spend). Returns false when refused, true otherwise; `onRecorded` runs only when a new total was written.
 */
export function recordTaskUsage(taskStore: TaskStore, taskId: string, total: TokenUsage, onRecorded?: () => void): boolean {
  const recorded = taskStore.getTask(taskId)?.tokenUsage;
  if (recorded && !usageCovers(total, recorded)) return false;
  if (recorded && usageCovers(recorded, total)) return true;
  taskStore.updateTokenUsage(taskId, total);
  onRecorded?.();
  return true;
}

/** Baseline + DB total of the task dir, or undefined when its DB is missing or unreadable. */
export async function readTaskDirUsage(taskDir: string): Promise<TokenUsage | undefined> {
  const result = await readOpenCodeDataHomeUsage(openCodeTaskDataHome(taskDir));
  if (result.kind !== 'ok') return undefined;
  return addTokenUsage(await readUsageBaseline(taskDir), mapOpenCodeUsageToTokenUsage(result.usage));
}

/**
 * The usage to carry as the baseline of a fresh launch, read BEFORE the launch wipes the task dir: the outgoing DB
 * is counted first (its stop may never have been recorded, e.g. Kookr restarted), so nothing it spent is lost.
 * Falls back to the usage already recorded on the task.
 */
export async function usageBeforeFreshLaunch(
  taskStore: TaskStore,
  taskId: string,
  taskDir: string,
  onRecorded?: () => void,
): Promise<TokenUsage | undefined> {
  const recorded = taskStore.getTask(taskId)?.tokenUsage;
  try {
    if (!(await isMarkedTaskDir(taskDir, taskId))) return recorded;
    const total = await readTaskDirUsage(taskDir);
    if (!total) return recorded;
    return recordTaskUsage(taskStore, taskId, total, onRecorded) ? total : recorded;
  } catch {
    return recorded;
  }
}
