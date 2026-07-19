/**
 * Data-directory growth soak harness.
 *
 * Unbounded append-only logs (budget-burn diagnostics ~46 MB, training-data
 * ~172 MB) were discovered only via multi-day prod dogfood. This soak simulates
 * heavy synthetic write churn against the real writers and asserts that each
 * artifact class stays bounded after the size-capped rotation added in this PR.
 *
 * Deterministic by construction: it drives the writers directly with tiny byte
 * caps and awaits their flush hooks — no real-time sleeps, no fake clocks needed.
 * Fast enough (< ~1s) to run in normal unit CI.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

import { homedir } from 'node:os';
import {
  JsonlProgressBudgetBurnDiagnosticSink,
  type ProgressBudgetBurnDiagnosticRecord,
} from '../../core/progress-budget-burn-diagnostics.js';
import {
  logTaskNaming,
  logResponseSuggestions,
  getTrainingDataDir,
  flushTrainingDataWrites,
} from '../../core/training-data-logger.js';

/** Total size in bytes of a log family: the live file plus its `.N` generations. */
function familySize(basePath: string): number {
  const dir = join(basePath, '..');
  const name = basePath.slice(dir.length + 1);
  let total = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === name || entry.startsWith(`${name}.`)) {
      total += statSync(join(dir, entry)).size;
    }
  }
  return total;
}

function generationCount(basePath: string): number {
  const dir = join(basePath, '..');
  const name = basePath.slice(dir.length + 1);
  return readdirSync(dir).filter((e) => e.startsWith(`${name}.`)).length;
}

function burnRecord(seq: number): ProgressBudgetBurnDiagnosticRecord {
  return {
    schemaVersion: 'progress-budget-burn-diagnostic.v1',
    mode: 'diagnostics_only',
    activeQueueInsertionEnabled: false,
    detector: 'progress_aware_budget_burn',
    timestamp: new Date('2026-05-19T12:00:00Z').toISOString(),
    taskId: `task-${seq}`,
    agentId: `agent-${seq % 8}`,
    taskStatus: 'inProgress',
    verdict: 'candidate',
    confidence: 'high',
    reason: 'synthetic burn sample under soak',
    totals: { costUsd: seq * 0.01, tokens: seq * 1000 },
    deltas: { costUsd: 0.25, tokens: 25_000, eventCount: 3 },
    evidenceLabels: ['cost_delta_positive', 'no_new_agent_events'],
  };
}

// Serialized real-fs appends; give generous headroom for CI under parallel load.
describe('data-dir growth soak', { timeout: 30_000 }, () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kookr-soak-'));
    vi.mocked(homedir).mockReturnValue(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('budget-burn diagnostics stay bounded under sustained write churn', async () => {
    const MAX_BYTES = 2 * 1024; // 2 KiB cap for a fast, deterministic soak
    const GENERATIONS = 2;
    const logPath = join(dataDir, '.kookr', 'budget-burn-diagnostics.jsonl');
    const sink = new JsonlProgressBudgetBurnDiagnosticSink(logPath, {
      maxLogBytes: MAX_BYTES,
      rotatedGenerations: GENERATIONS,
    });

    // Each record (~380 bytes) fits ~5 to a generation, so 200 writes force
    // dozens of rotations — far more than enough to fill and drop past gen 2.
    for (let i = 0; i < 200; i++) sink.append(burnRecord(i));
    await sink.flush();

    // Live file bounded near the cap; total family bounded by (gens+1)*cap.
    expect(statSync(logPath).size).toBeLessThanOrEqual(MAX_BYTES + 1024);
    expect(generationCount(logPath)).toBeLessThanOrEqual(GENERATIONS);
    expect(familySize(logPath)).toBeLessThanOrEqual((GENERATIONS + 1) * (MAX_BYTES + 1024));
    expect(existsSync(`${logPath}.${GENERATIONS + 1}`)).toBe(false);
  });

  test('training-data logs stay bounded under sustained write churn', async () => {
    const MAX_BYTES = 2 * 1024;
    const GENERATIONS = 2;
    const opts = { maxBytes: MAX_BYTES, rotatedGenerations: GENERATIONS };

    for (let i = 0; i < 200; i++) {
      logTaskNaming(`prompt ${i} ${'x'.repeat(30)}`, '/project', undefined, `name-${i}`, opts);
      logResponseSuggestions(
        { lastAssistantMessage: `msg ${i} ${'y'.repeat(30)}`, cwd: '/project' },
        [`suggestion-${i}`],
        opts,
      );
    }
    await flushTrainingDataWrites();

    for (const file of ['task-naming.jsonl', 'response-suggestions.jsonl']) {
      const logPath = join(getTrainingDataDir(), file);
      expect(statSync(logPath).size).toBeLessThanOrEqual(MAX_BYTES + 1024);
      expect(generationCount(logPath)).toBeLessThanOrEqual(GENERATIONS);
      expect(familySize(logPath)).toBeLessThanOrEqual((GENERATIONS + 1) * (MAX_BYTES + 1024));
      expect(existsSync(`${logPath}.${GENERATIONS + 1}`)).toBe(false);
    }
  });

  test('whole data dir stays compact after heavy mixed churn', async () => {
    const MAX_BYTES = 2 * 1024;
    const GENERATIONS = 2;
    const burnPath = join(dataDir, '.kookr', 'budget-burn-diagnostics.jsonl');
    const sink = new JsonlProgressBudgetBurnDiagnosticSink(burnPath, {
      maxLogBytes: MAX_BYTES,
      rotatedGenerations: GENERATIONS,
    });
    const opts = { maxBytes: MAX_BYTES, rotatedGenerations: GENERATIONS };

    for (let i = 0; i < 150; i++) {
      sink.append(burnRecord(i));
      logTaskNaming(`p${i} ${'x'.repeat(30)}`, '/project', undefined, `name-${i}`, opts);
      logResponseSuggestions({ lastAssistantMessage: `m${i} ${'y'.repeat(30)}` }, [`s-${i}`], opts);
    }
    await Promise.all([sink.flush(), flushTrainingDataWrites()]);

    // Three log families, each capped at (gens+1)*(cap + slack).
    const perFamilyCeiling = (GENERATIONS + 1) * (MAX_BYTES + 1024);
    const ceiling = 3 * perFamilyCeiling;
    expect(familySize(burnPath)).toBeLessThanOrEqual(perFamilyCeiling);
    expect(familySize(join(getTrainingDataDir(), 'task-naming.jsonl'))).toBeLessThanOrEqual(perFamilyCeiling);
    expect(familySize(join(getTrainingDataDir(), 'response-suggestions.jsonl'))).toBeLessThanOrEqual(perFamilyCeiling);

    const totalKookr =
      familySize(burnPath) +
      familySize(join(getTrainingDataDir(), 'task-naming.jsonl')) +
      familySize(join(getTrainingDataDir(), 'response-suggestions.jsonl'));
    // Without rotation this churn would write hundreds of KiB; bounded it stays well under the ceiling.
    expect(totalKookr).toBeLessThanOrEqual(ceiling);
  });
});
