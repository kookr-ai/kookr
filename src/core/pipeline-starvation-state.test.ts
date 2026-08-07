import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listPipelineStarvationHealth,
  loadPipelineStarvationState,
  savePipelineStarvationState,
} from './pipeline-starvation-state.js';
import {
  effectiveStarvationScoutCooldownMs,
  PIPELINE_STARVATION_STATE_SCHEMA,
  STARVATION_SCOUT_COOLDOWN_FLOOR_MS,
  STARVATION_SCOUT_DEDUP_MS,
  type PipelineStarvationRepoState,
} from './pipeline-starvation.js';

const NOW = Date.parse('2026-07-30T08:15:00.000Z');

/** Build a persisted state with `n` recent blocked-empty timestamps. */
function stateWithEmpties(repo: string, n: number): PipelineStarvationRepoState {
  const blockedEmptyAt: string[] = [];
  const handledRunKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    blockedEmptyAt.push(new Date(NOW - (i + 1) * 20 * 60 * 1000).toISOString());
    handledRunKeys.push(`e${i + 1}`);
  }
  return {
    schemaVersion: PIPELINE_STARVATION_STATE_SCHEMA,
    repo,
    blockedEmptyAt,
    handledRunKeys,
    updatedAt: new Date(NOW).toISOString(),
  };
}

describe('listPipelineStarvationHealth (#2171 effectiveScoutCooldownMs)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'kookr-starv-state-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  test('projects the adaptive cooldown from the persisted drought depth', async () => {
    await savePipelineStarvationState(stateWithEmpties('jeanibarz/lucy', 6), { stateDir });
    await savePipelineStarvationState(stateWithEmpties('kookr-ai/kookr', 0), { stateDir });

    const health = await listPipelineStarvationHealth({ stateDir, nowMs: NOW });

    // consecutive=6 is the exact drought depth reported in #2171 → 30m floor.
    expect(health['jeanibarz/lucy']?.consecutiveBlockedEmpty).toBe(6);
    expect(health['jeanibarz/lucy']?.effectiveScoutCooldownMs)
      .toBe(STARVATION_SCOUT_COOLDOWN_FLOOR_MS);
    // A repo with no recent empties reports the full baseline window.
    expect(health['kookr-ai/kookr']?.consecutiveBlockedEmpty).toBe(0);
    expect(health['kookr-ai/kookr']?.effectiveScoutCooldownMs).toBe(STARVATION_SCOUT_DEDUP_MS);
    // Projection stays consistent with the pure evaluator's cooldown.
    expect(health['jeanibarz/lucy']?.effectiveScoutCooldownMs)
      .toBe(effectiveStarvationScoutCooldownMs(6));
  });

  test('empty state dir projects nothing', async () => {
    const health = await listPipelineStarvationHealth({ stateDir, nowMs: NOW });
    expect(Object.keys(health)).toHaveLength(0);
  });

  test('round-trips durable state through save/load', async () => {
    const state = stateWithEmpties('jeanibarz/lucy', 3);
    await savePipelineStarvationState(state, { stateDir });
    const loaded = await loadPipelineStarvationState('jeanibarz/lucy', { stateDir, nowMs: NOW });
    expect(loaded.blockedEmptyAt).toHaveLength(3);
    expect(loaded.handledRunKeys).toEqual(state.handledRunKeys);
  });
});
