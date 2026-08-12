import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listPipelineStarvationHealth,
  loadInventPriorityClassHealth,
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

describe('loadInventPriorityClassHealth (#2358)', () => {
  let kookrDir: string;

  beforeEach(async () => {
    kookrDir = await mkdtemp(join(tmpdir(), 'kookr-invent-health-'));
    await mkdir(join(kookrDir, 'playbook-state', 'queue-feeder'), { recursive: true });
  });

  afterEach(async () => {
    await rm(kookrDir, { recursive: true, force: true });
  });

  test('rolls product vs micro invent classes from the queue-feeder ledger', async () => {
    const ledger = join(kookrDir, 'playbook-state', 'queue-feeder', 'decisions.jsonl');
    const lines = [
      {
        ts: new Date(NOW - 60_000).toISOString(),
        action: 'invent-product-wave',
        inventPriorityClass: 'product',
        leafCount: 0,
      },
      {
        ts: new Date(NOW - 30_000).toISOString(),
        action: 'emit-secondary',
        inventPriorityClass: 'micro',
        leafCount: 2,
      },
      {
        ts: new Date(NOW - 10_000).toISOString(),
        action: 'shred',
        inventPriorityClass: 'product',
        productMetricBlocking: true,
        leafCount: 3,
      },
      // Outside window
      {
        ts: new Date(NOW - 48 * 3_600_000).toISOString(),
        action: 'emit-secondary',
        inventPriorityClass: 'micro',
        leafCount: 5,
      },
    ];
    await writeFile(ledger, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const health = await loadInventPriorityClassHealth({
      kookrDir,
      nowMs: NOW,
      windowHours: 24,
    });
    expect(health.product).toBe(1 + 3); // invent wave counts as 1 + shred leafCount 3
    expect(health.micro).toBe(2);
    expect(health.other).toBe(0);
    expect(health.windowHours).toBe(24);
  });

  test('missing ledger returns zeros', async () => {
    const health = await loadInventPriorityClassHealth({
      kookrDir,
      nowMs: NOW,
    });
    expect(health).toEqual({ product: 0, micro: 0, other: 0, windowHours: 24 });
  });
});
