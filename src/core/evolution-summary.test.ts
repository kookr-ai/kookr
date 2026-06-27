import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEvolutionRunProjection } from './evolution-summary.js';

describe('readEvolutionRunProjection', () => {
  test('projects champion, outcome counts, score trajectory, stop reason, and malformed lines', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'evolution-run-'));
    try {
      await writeFile(join(cwd, 'champion.json'), JSON.stringify({
        score: 1.42,
        artifactRef: 'trials/iter-2/strategy.json',
        iteration: 2,
        promotedAt: '2026-06-20T20:00:00.000Z',
        deadlineAt: '2026-06-20T22:00:00.000Z',
      }));
      await writeFile(join(cwd, 'evolution-trials.jsonl'), [
        JSON.stringify({ iteration: 0, outcome: 'baseline', score: 1.0 }),
        JSON.stringify({ iteration: 1, outcome: 'regressed', score: 0.9 }),
        JSON.stringify({ iteration: 2, outcome: 'promoted', score: 1.42 }),
        JSON.stringify({ iteration: 3, outcome: 'failed', notes: 'missing data' }),
        '{bad',
        '',
      ].join('\n'));
      await writeFile(join(cwd, '.evolution-stop'), 'STOP: plateau\n');

      await expect(readEvolutionRunProjection(cwd)).resolves.toEqual({
        champion: {
          score: 1.42,
          artifactRef: 'trials/iter-2/strategy.json',
          iteration: 2,
          promotedAt: '2026-06-20T20:00:00.000Z',
          deadlineAt: '2026-06-20T22:00:00.000Z',
        },
        bestScore: 1.42,
        outcomeCounts: {
          baseline: 1,
          promoted: 1,
          neutral: 0,
          regressed: 1,
          failed: 1,
        },
        trajectory: [
          { iteration: 0, score: 1.0, outcome: 'baseline' },
          { iteration: 1, score: 0.9, outcome: 'regressed' },
          { iteration: 2, score: 1.42, outcome: 'promoted' },
        ],
        stopReason: 'plateau',
        trialCount: 4,
        malformedTrialLines: 1,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
