import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EvolutionChampionRecord,
  EvolutionTrialOutcome,
  EvolutionTrialRecord,
} from '../shared/contracts/evolution.js';
import { EVOLUTION_TRIAL_OUTCOMES } from '../shared/contracts/evolution.js';
import { atomicWriteFile } from './persistence-utils.js';

export const EVOLUTION_CHAMPION_FILE = 'champion.json';
export const EVOLUTION_TRIAL_LOG_FILE = 'evolution-trials.jsonl';

export type EvolutionRecordValidationResult<T> =
  | { ok: true; record: T }
  | { ok: false; error: string };

export interface WriteEvolutionChampionOptions {
  writeFileAtomically?: (filePath: string, data: string) => Promise<void>;
}

export async function writeEvolutionChampionRecord(
  runCwd: string,
  champion: unknown,
  options: WriteEvolutionChampionOptions = {},
): Promise<EvolutionChampionRecord> {
  const validation = validateEvolutionChampionRecord(champion);
  if (!validation.ok) {
    throw new Error(`Invalid ${EVOLUTION_CHAMPION_FILE}: ${validation.error}`);
  }

  await mkdir(runCwd, { recursive: true });
  const writeFileAtomically = options.writeFileAtomically ?? atomicWriteFile;
  await writeFileAtomically(
    join(runCwd, EVOLUTION_CHAMPION_FILE),
    `${JSON.stringify(validation.record, null, 2)}\n`,
  );
  return validation.record;
}

export async function appendEvolutionTrialRecord(
  runCwd: string,
  trial: unknown,
): Promise<EvolutionTrialRecord> {
  const validation = validateEvolutionTrialRecord(trial);
  if (!validation.ok) {
    throw new Error(`Invalid ${EVOLUTION_TRIAL_LOG_FILE} record: ${validation.error}`);
  }

  await mkdir(runCwd, { recursive: true });
  const fh = await open(join(runCwd, EVOLUTION_TRIAL_LOG_FILE), 'a');
  try {
    await fh.writeFile(`${JSON.stringify(validation.record)}\n`, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  return validation.record;
}

export function validateEvolutionChampionRecord(value: unknown): EvolutionRecordValidationResult<EvolutionChampionRecord> {
  if (!isRecord(value)) return { ok: false, error: 'record must be an object' };
  const unsupported = unsupportedKeys(value, CHAMPION_KEYS);
  if (unsupported) return { ok: false, error: `unsupported field "${unsupported}"` };

  if (!Object.hasOwn(value, 'score')) {
    return { ok: false, error: 'score is required' };
  }
  if (value.score !== null && !isFiniteNumber(value.score)) {
    return { ok: false, error: 'score must be a finite number or null' };
  }

  const metrics = optionalMetrics(value.metrics, 'metrics');
  if (!metrics.ok) return metrics;
  const artifactRef = optionalNonEmptyString(value.artifactRef, 'artifactRef');
  if (!artifactRef.ok) return artifactRef;
  const iteration = optionalNonNegativeInteger(value.iteration, 'iteration');
  if (!iteration.ok) return iteration;
  const promotedAt = optionalDateTime(value.promotedAt, 'promotedAt');
  if (!promotedAt.ok) return promotedAt;
  const runId = optionalNonEmptyString(value.runId, 'runId');
  if (!runId.ok) return runId;
  const deadlineAt = optionalDateTime(value.deadlineAt, 'deadlineAt');
  if (!deadlineAt.ok) return deadlineAt;

  return {
    ok: true,
    record: {
      score: value.score,
      ...(metrics.value ? { metrics: metrics.value } : {}),
      ...(artifactRef.value ? { artifactRef: artifactRef.value } : {}),
      ...(typeof iteration.value === 'number' ? { iteration: iteration.value } : {}),
      ...(promotedAt.value ? { promotedAt: promotedAt.value } : {}),
      ...(runId.value ? { runId: runId.value } : {}),
      ...(deadlineAt.value ? { deadlineAt: deadlineAt.value } : {}),
    },
  };
}

export function validateEvolutionTrialRecord(value: unknown): EvolutionRecordValidationResult<EvolutionTrialRecord> {
  if (!isRecord(value)) return { ok: false, error: 'record must be an object' };
  const unsupported = unsupportedKeys(value, TRIAL_KEYS);
  if (unsupported) return { ok: false, error: `unsupported field "${unsupported}"` };

  if (!isEvolutionTrialOutcome(value.outcome)) {
    return { ok: false, error: `outcome must be one of ${EVOLUTION_TRIAL_OUTCOMES.join(', ')}` };
  }
  const iteration = optionalNonNegativeInteger(value.iteration, 'iteration');
  if (!iteration.ok) return iteration;
  const score = optionalFiniteNumber(value.score, 'score');
  if (!score.ok) return score;
  const delta = optionalFiniteNumber(value.delta, 'delta');
  if (!delta.ok) return delta;
  const metrics = optionalMetrics(value.metrics, 'metrics');
  if (!metrics.ok) return metrics;
  const notes = optionalString(value.notes, 'notes');
  if (!notes.ok) return notes;
  const durationMs = optionalNonNegativeNumber(value.durationMs, 'durationMs');
  if (!durationMs.ok) return durationMs;
  const costUsd = optionalNonNegativeNumber(value.costUsd, 'costUsd');
  if (!costUsd.ok) return costUsd;
  const evaluatedAt = optionalDateTime(value.evaluatedAt, 'evaluatedAt');
  if (!evaluatedAt.ok) return evaluatedAt;

  return {
    ok: true,
    record: {
      outcome: value.outcome,
      ...(typeof iteration.value === 'number' ? { iteration: iteration.value } : {}),
      ...(typeof score.value === 'number' ? { score: score.value } : {}),
      ...(typeof delta.value === 'number' ? { delta: delta.value } : {}),
      ...(metrics.value ? { metrics: metrics.value } : {}),
      ...(typeof notes.value === 'string' ? { notes: notes.value } : {}),
      ...(typeof durationMs.value === 'number' ? { durationMs: durationMs.value } : {}),
      ...(typeof costUsd.value === 'number' ? { costUsd: costUsd.value } : {}),
      ...(evaluatedAt.value ? { evaluatedAt: evaluatedAt.value } : {}),
    },
  };
}

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const CHAMPION_KEYS = new Set(['score', 'metrics', 'artifactRef', 'iteration', 'promotedAt', 'runId', 'deadlineAt']);
const TRIAL_KEYS = new Set(['iteration', 'outcome', 'score', 'delta', 'metrics', 'notes', 'durationMs', 'costUsd', 'evaluatedAt']);

function unsupportedKeys(value: Record<string, unknown>, allowed: Set<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

function isEvolutionTrialOutcome(value: unknown): value is EvolutionTrialOutcome {
  return typeof value === 'string' && (EVOLUTION_TRIAL_OUTCOMES as readonly string[]).includes(value);
}

function optionalFiniteNumber(value: unknown, field: string): ValidationValue<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isFiniteNumber(value)) return { ok: false, error: `${field} must be a finite number` };
  return { ok: true, value };
}

function optionalNonNegativeNumber(value: unknown, field: string): ValidationValue<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isFiniteNumber(value) || value < 0) return { ok: false, error: `${field} must be a non-negative finite number` };
  return { ok: true, value };
}

function optionalNonNegativeInteger(value: unknown, field: string): ValidationValue<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) {
    return { ok: false, error: `${field} must be a non-negative integer` };
  }
  return { ok: true, value };
}

function optionalString(value: unknown, field: string): ValidationValue<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` };
  return { ok: true, value };
}

function optionalNonEmptyString(value: unknown, field: string): ValidationValue<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: `${field} must be a non-empty string` };
  }
  return { ok: true, value };
}

function optionalDateTime(value: unknown, field: string): ValidationValue<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || !DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    return { ok: false, error: `${field} must be an ISO date-time string` };
  }
  return { ok: true, value };
}

function optionalMetrics(value: unknown, field: string): ValidationValue<Record<string, string | number | boolean | null> | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, error: `${field} must be an object` };
  const metrics: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      entry !== null
      && typeof entry !== 'string'
      && typeof entry !== 'number'
      && typeof entry !== 'boolean'
    ) {
      return { ok: false, error: `${field}.${key} must be a string, number, boolean, or null` };
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      return { ok: false, error: `${field}.${key} must be a finite number` };
    }
    metrics[key] = entry;
  }
  return { ok: true, value: metrics };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ValidationValue<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
