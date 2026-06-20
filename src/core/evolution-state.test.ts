import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVOLUTION_CHAMPION_FILE,
  EVOLUTION_TRIAL_LOG_FILE,
  appendEvolutionTrialRecord,
  validateEvolutionChampionRecord,
  validateEvolutionTrialRecord,
  writeEvolutionChampionRecord,
} from './evolution-state.js';

describe('evolution state helpers', () => {
  test('atomically writes champion.json in the documented shape', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'evolution-state-'));
    try {
      const champion = await writeEvolutionChampionRecord(cwd, {
        score: 1.42,
        metrics: { sharpe: 1.42, trades: 22, live: true, skipped: null },
        artifactRef: 'trials/iter-2/strategy.json',
        iteration: 2,
        promotedAt: '2026-06-20T20:00:00.000Z',
        runId: 'run-1',
        deadlineAt: '2026-06-20T21:00:00+01:00',
      });

      expect(champion).toEqual({
        score: 1.42,
        metrics: { sharpe: 1.42, trades: 22, live: true, skipped: null },
        artifactRef: 'trials/iter-2/strategy.json',
        iteration: 2,
        promotedAt: '2026-06-20T20:00:00.000Z',
        runId: 'run-1',
        deadlineAt: '2026-06-20T21:00:00+01:00',
      });
      await expect(readJson(join(cwd, EVOLUTION_CHAMPION_FILE))).resolves.toEqual(champion);
      await expect(readdir(cwd)).resolves.toEqual([EVOLUTION_CHAMPION_FILE]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('preserves the previous champion when an interrupted atomic write throws before rename', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'evolution-state-'));
    try {
      const championPath = join(cwd, EVOLUTION_CHAMPION_FILE);
      const previous = { score: 1, artifactRef: 'champion.json', iteration: 0 };
      await writeFile(championPath, `${JSON.stringify(previous)}\n`);

      await expect(writeEvolutionChampionRecord(cwd, {
        score: 2,
        artifactRef: 'trials/iter-1/strategy.json',
        iteration: 1,
      }, {
        writeFileAtomically: async (filePath, data) => {
          await writeFile(`${filePath}.tmp`, data.slice(0, 12));
          throw new Error('interrupted before rename');
        },
      })).rejects.toThrow('interrupted before rename');

      await expect(readJson(championPath)).resolves.toEqual(previous);
      await expect(readFile(`${championPath}.tmp`, 'utf8')).resolves.toBe('{\n  "score":');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('appends one validated trial record per JSONL line', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'evolution-state-'));
    try {
      await appendEvolutionTrialRecord(cwd, {
        iteration: 0,
        outcome: 'baseline',
        score: 1,
        metrics: { sharpe: 1 },
        notes: 'baseline',
        durationMs: 100,
        evaluatedAt: '2026-06-20T20:00:00.000Z',
      });
      await appendEvolutionTrialRecord(cwd, {
        iteration: 1,
        outcome: 'promoted',
        score: 1.2,
        delta: 0.2,
        costUsd: 0.04,
        evaluatedAt: '2026-06-20T20:01:00.000Z',
      });

      await expect(readJsonLines(join(cwd, EVOLUTION_TRIAL_LOG_FILE))).resolves.toEqual([
        {
          iteration: 0,
          outcome: 'baseline',
          score: 1,
          metrics: { sharpe: 1 },
          notes: 'baseline',
          durationMs: 100,
          evaluatedAt: '2026-06-20T20:00:00.000Z',
        },
        {
          iteration: 1,
          outcome: 'promoted',
          score: 1.2,
          delta: 0.2,
          costUsd: 0.04,
          evaluatedAt: '2026-06-20T20:01:00.000Z',
        },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('rejects invalid trial records without appending a malformed line', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'evolution-state-'));
    try {
      await appendEvolutionTrialRecord(cwd, { iteration: 0, outcome: 'baseline', score: 1 });
      await expect(appendEvolutionTrialRecord(cwd, {
        iteration: 1,
        outcome: 'winner',
        score: 2,
      })).rejects.toThrow('outcome must be one of');

      await expect(readJsonLines(join(cwd, EVOLUTION_TRIAL_LOG_FILE))).resolves.toEqual([
        { iteration: 0, outcome: 'baseline', score: 1 },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('validates champion record edge cases before writing', () => {
    expect(validateEvolutionChampionRecord({ artifactRef: 'missing-score' })).toEqual({
      ok: false,
      error: 'score is required',
    });
    expect(validateEvolutionChampionRecord({ score: 1, extra: true })).toEqual({
      ok: false,
      error: 'unsupported field "extra"',
    });
    expect(validateEvolutionChampionRecord({ score: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      error: 'score must be a finite number or null',
    });
    expect(validateEvolutionChampionRecord({ score: 1, metrics: { nested: { value: 1 } } })).toEqual({
      ok: false,
      error: 'metrics.nested must be a string, number, boolean, or null',
    });
    expect(validateEvolutionChampionRecord({ score: 1, promotedAt: 'not-a-date' })).toEqual({
      ok: false,
      error: 'promotedAt must be an ISO date-time string',
    });
    expect(validateEvolutionChampionRecord({ score: 1, deadlineAt: '2026-06-20' })).toEqual({
      ok: false,
      error: 'deadlineAt must be an ISO date-time string',
    });
    expect(validateEvolutionChampionRecord({ score: 1, deadlineAt: '2026-06-20T20:00:00Z' })).toEqual({
      ok: true,
      record: { score: 1, deadlineAt: '2026-06-20T20:00:00Z' },
    });
  });

  test('validates trial record edge cases before appending', () => {
    expect(validateEvolutionTrialRecord({ outcome: 'promoted', score: Number.NaN })).toEqual({
      ok: false,
      error: 'score must be a finite number',
    });
    expect(validateEvolutionTrialRecord({ outcome: 'promoted', durationMs: -1 })).toEqual({
      ok: false,
      error: 'durationMs must be a non-negative finite number',
    });
    expect(validateEvolutionTrialRecord({ outcome: 'promoted', costUsd: -0.01 })).toEqual({
      ok: false,
      error: 'costUsd must be a non-negative finite number',
    });
    expect(validateEvolutionTrialRecord({ outcome: 'promoted', evaluatedAt: 'not-a-date' })).toEqual({
      ok: false,
      error: 'evaluatedAt must be an ISO date-time string',
    });
    expect(validateEvolutionTrialRecord({ outcome: 'promoted', evaluatedAt: '2026-06-20' })).toEqual({
      ok: false,
      error: 'evaluatedAt must be an ISO date-time string',
    });
    expect(validateEvolutionTrialRecord({ outcome: 'promoted', metrics: { sharpe: Number.NaN } })).toEqual({
      ok: false,
      error: 'metrics.sharpe must be a finite number',
    });
  });
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function readJsonLines(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as unknown);
}
