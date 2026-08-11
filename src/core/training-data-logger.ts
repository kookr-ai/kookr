/**
 * Training data logger for future local model fine-tuning.
 *
 * Appends (input, output) JSONL entries for task-naming and response-suggestion
 * calls so we can later fine-tune a small local model (e.g. Qwen2.5-1.5B with LoRA).
 *
 * Fire-and-forget: never throws, never blocks the caller.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import { appendJsonlWithRotation } from './jsonl-rotation.js';

function trainingDataDir(): string {
  return join(homedir(), '.kookr', 'training-data');
}

/** Rotate a training-data log before an append would exceed this size. */
export const DEFAULT_TRAINING_DATA_MAX_LOG_BYTES = 64 * 1024 * 1024;
/** Rotated generations retained by default (keeps .1 and .2). */
export const DEFAULT_TRAINING_DATA_ROTATED_GENERATIONS = 2;

export interface TrainingDataRotationOptions {
  /** Rotate before an append would exceed this many bytes. Default 64 MiB. */
  maxBytes?: number;
  /** Number of rotated generations to retain. Default 2. */
  rotatedGenerations?: number;
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

// Per-file promise queue so concurrent writes to the same log serialize their
// stat/rotate/append sequence (production has two stable paths, so this map
// stays tiny). Rotation keeps the training-data dir bounded (prod grew to
// ~172 MB unbounded).
const appendQueues = new Map<string, Promise<void>>();

function enqueueAppend(
  filePath: string,
  entry: unknown,
  options: TrainingDataRotationOptions,
): void {
  const line = JSON.stringify(entry) + '\n';
  const rotation = {
    maxBytes: options.maxBytes ?? DEFAULT_TRAINING_DATA_MAX_LOG_BYTES,
    rotatedGenerations: options.rotatedGenerations ?? DEFAULT_TRAINING_DATA_ROTATED_GENERATIONS,
  };
  const prev = appendQueues.get(filePath) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* keep the queue alive after an earlier write failure */ })
    .then(() =>
      appendJsonlWithRotation(filePath, line, {
        ...rotation,
        // Training logs contain full task prompts; match secret-adjacent stores.
        dirMode: 0o700,
        fileMode: 0o600,
      }),
    )
    .catch(() => { /* fire-and-forget: never throw, never block the caller */ });
  appendQueues.set(filePath, next);
}

export function logTaskNaming(
  prompt: string,
  cwd: string,
  criteria: string | undefined,
  output: string,
  options: TrainingDataRotationOptions = {},
): void {
  const entry: TaskNamingEntry = {
    timestamp: new Date().toISOString(),
    input: { prompt, cwd, ...(criteria !== undefined ? { criteria } : {}) },
    output,
  };
  const filePath = join(trainingDataDir(), 'task-naming.jsonl');
  enqueueAppend(filePath, entry, options);
}

export function logResponseSuggestions(
  ctx: { lastAssistantMessage: string; taskPrompt?: string; cwd?: string; recentToolCalls?: string[] },
  output: string[],
  options: TrainingDataRotationOptions = {},
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
  enqueueAppend(filePath, entry, options);
}

/**
 * Await pending fire-and-forget training-data writes. Exposed for tests (and any
 * future shutdown hook); production callers do not need to await. Writes are
 * fire-and-forget, so an abrupt exit without a flush drops the un-written tail —
 * acceptable for optional model-tuning data.
 */
export async function flushTrainingDataWrites(): Promise<void> {
  await Promise.all([...appendQueues.values()].map((p) => p.catch(() => {})));
}

/** Exposed for testing — returns the base directory path */
export function getTrainingDataDir(): string {
  return trainingDataDir();
}
