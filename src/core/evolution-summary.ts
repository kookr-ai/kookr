import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EvolutionChampionRecord,
  EvolutionRunProjection,
  EvolutionTrialOutcome,
  EvolutionTrialRecord,
} from '../shared/contracts/evolution.js';
import { EVOLUTION_TRIAL_OUTCOMES } from '../shared/contracts/evolution.js';

export async function readEvolutionRunProjection(runCwd: string): Promise<EvolutionRunProjection> {
  const [champion, trials, stopReason] = await Promise.all([
    readChampion(join(runCwd, 'champion.json')),
    readTrials(join(runCwd, 'evolution-trials.jsonl')),
    readStopReason(join(runCwd, '.evolution-stop')),
  ]);

  const outcomeCounts = emptyOutcomeCounts();
  const trajectory: EvolutionRunProjection['trajectory'] = [];
  for (const trial of trials.records) {
    outcomeCounts[trial.outcome] += 1;
    if (typeof trial.score === 'number') {
      trajectory.push({
        iteration: typeof trial.iteration === 'number' ? trial.iteration : trajectory.length,
        score: trial.score,
        outcome: trial.outcome,
      });
    }
  }

  return {
    champion,
    bestScore: champion?.score ?? null,
    outcomeCounts,
    trajectory,
    stopReason,
    trialCount: trials.records.length,
    malformedTrialLines: trials.malformedLines,
  };
}

function emptyOutcomeCounts(): Record<EvolutionTrialOutcome, number> {
  return Object.fromEntries(EVOLUTION_TRIAL_OUTCOMES.map((outcome) => [outcome, 0])) as Record<EvolutionTrialOutcome, number>;
}

async function readChampion(path: string): Promise<EvolutionChampionRecord | null> {
  const parsed = await readJsonIfPresent(path);
  if (!isRecord(parsed)) return null;
  return {
    score: typeof parsed.score === 'number' ? parsed.score : null,
    ...(isMetrics(parsed.metrics) ? { metrics: parsed.metrics } : {}),
    ...(typeof parsed.artifactRef === 'string' ? { artifactRef: parsed.artifactRef } : {}),
    ...(typeof parsed.iteration === 'number' ? { iteration: parsed.iteration } : {}),
    ...(typeof parsed.promotedAt === 'string' ? { promotedAt: parsed.promotedAt } : {}),
    ...(typeof parsed.runId === 'string' ? { runId: parsed.runId } : {}),
  };
}

async function readTrials(path: string): Promise<{ records: EvolutionTrialRecord[]; malformedLines: number }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], malformedLines: 0 };
    throw err;
  }

  const records: EvolutionTrialRecord[] = [];
  let malformedLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = normalizeTrial(parsed);
      if (record) records.push(record);
      else malformedLines += 1;
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines };
}

function normalizeTrial(value: unknown): EvolutionTrialRecord | null {
  if (!isRecord(value) || !isOutcome(value.outcome)) return null;
  return {
    outcome: value.outcome,
    ...(typeof value.iteration === 'number' ? { iteration: value.iteration } : {}),
    ...(typeof value.score === 'number' ? { score: value.score } : {}),
    ...(typeof value.delta === 'number' ? { delta: value.delta } : {}),
    ...(isMetrics(value.metrics) ? { metrics: value.metrics } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
    ...(typeof value.costUsd === 'number' ? { costUsd: value.costUsd } : {}),
    ...(typeof value.evaluatedAt === 'string' ? { evaluatedAt: value.evaluatedAt } : {}),
  };
}

async function readStopReason(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) return null;
    return firstLine.replace(/^STOP:\s*/i, '').trim() || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function readJsonIfPresent(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function isOutcome(value: unknown): value is EvolutionTrialOutcome {
  return typeof value === 'string' && (EVOLUTION_TRIAL_OUTCOMES as readonly string[]).includes(value);
}

function isMetrics(value: unknown): value is Record<string, string | number | boolean | null> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => (
    entry === null
    || typeof entry === 'string'
    || typeof entry === 'number'
    || typeof entry === 'boolean'
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
