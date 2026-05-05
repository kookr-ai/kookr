/**
 * Training data logger for future local model fine-tuning.
 *
 * Appends (input, output) JSONL entries for task-naming and response-suggestion
 * calls so we can later fine-tune a small local model (e.g. Qwen2.5-1.5B with LoRA).
 *
 * Fire-and-forget: never throws, never blocks the caller.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function trainingDataDir(): string {
  return join(homedir(), '.kookr', 'training-data');
}

export interface TaskNamingEntry {
  timestamp: string;
  input: { prompt: string; cwd: string; criteria?: string };
  output: string;
}

export interface ResponseSuggestionEntry {
  timestamp: string;
  input: {
    lastAssistantMessage: string;
    taskPrompt?: string;
    cwd?: string;
    recentToolCalls?: string[];
  };
  output: string[];
}

async function appendJsonl(filePath: string, entry: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

export function logTaskNaming(
  prompt: string,
  cwd: string,
  criteria: string | undefined,
  output: string,
): void {
  const entry: TaskNamingEntry = {
    timestamp: new Date().toISOString(),
    input: { prompt, cwd, ...(criteria !== undefined ? { criteria } : {}) },
    output,
  };
  const filePath = join(trainingDataDir(), 'task-naming.jsonl');
  appendJsonl(filePath, entry).catch(() => {});
}

export function logResponseSuggestions(
  ctx: { lastAssistantMessage: string; taskPrompt?: string; cwd?: string; recentToolCalls?: string[] },
  output: string[],
): void {
  const entry: ResponseSuggestionEntry = {
    timestamp: new Date().toISOString(),
    input: {
      lastAssistantMessage: ctx.lastAssistantMessage,
      ...(ctx.taskPrompt !== undefined ? { taskPrompt: ctx.taskPrompt } : {}),
      ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      ...(ctx.recentToolCalls !== undefined ? { recentToolCalls: ctx.recentToolCalls } : {}),
    },
    output,
  };
  const filePath = join(trainingDataDir(), 'response-suggestions.jsonl');
  appendJsonl(filePath, entry).catch(() => {});
}

/** Exposed for testing — returns the base directory path */
export function getTrainingDataDir(): string {
  return trainingDataDir();
}
