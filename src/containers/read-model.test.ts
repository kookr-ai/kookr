import { describe, expect, test } from 'vitest';
import type { ContainerInfo } from './ports.js';
import { buildContainerReadModel, type ContainerReadModelInput } from './read-model.js';

const now = new Date('2026-01-01T00:10:00Z');
const c = (o: Partial<ContainerInfo> = {}): ContainerInfo => ({ id: 'i', name: 'kookr-oc-x', state: 'running', createdAt: now, labels: {}, ...o });
const base = (o: Partial<ContainerReadModelInput> = {}): ContainerReadModelInput => ({
  launchMode: 'container', taskLive: true, container: c(), a2aState: 'WORKING', consecutiveProbeMisses: 0,
  lastProbeAt: new Date(now.getTime() - 10_000), now, ...o,
});

describe('buildContainerReadModel', () => {
  test('healthy: running, probed recently, task live', () => {
    expect(buildContainerReadModel(base())).toMatchObject({ health: 'healthy', divergence: 'none', kookrState: 'live', hooksBlind: false });
  });
  test('three missed probes => unknown + probe_stale, never healthy', () => {
    expect(buildContainerReadModel(base({ consecutiveProbeMisses: 3 }))).toMatchObject({ health: 'unknown', divergence: 'probe_stale' });
    expect(buildContainerReadModel(base({ consecutiveProbeMisses: 2 })).health).toBe('healthy');
  });
  test('a probe that never ran is stale, not healthy', () => {
    expect(buildContainerReadModel(base({ lastProbeAt: undefined })).health).toBe('unknown');
  });
  test('container dead while the task is live: failed + container_dead_task_live (container state wins over A2A)', () => {
    const r = buildContainerReadModel(base({ container: c({ state: 'exited', exitCode: 137 }), a2aState: 'WORKING' }));
    expect(r).toMatchObject({ health: 'failed', divergence: 'container_dead_task_live' });
  });
  test('OOM-killed container is failed', () => {
    expect(buildContainerReadModel(base({ taskLive: false, container: c({ state: 'exited', oomKilled: true }) })).health).toBe('failed');
  });
  test('terminal task with a running container is flagged', () => {
    expect(buildContainerReadModel(base({ taskLive: false })).divergence).toBe('task_terminal_container_live');
  });
  test('A2A terminal but ledger not terminal => a2a_ahead_of_ledger; with ledger terminal => none', () => {
    expect(buildContainerReadModel(base({ a2aState: 'COMPLETED' })).divergence).toBe('a2a_ahead_of_ledger');
    expect(buildContainerReadModel(base({ a2aState: 'COMPLETED', ledgerTerminal: true })).divergence).toBe('none');
  });
  test('hooks blind when ingest lag exceeds 120 s while running => degraded, recoverable', () => {
    expect(buildContainerReadModel(base({ ingestLagMs: 121_000 }))).toMatchObject({ hooksBlind: true, health: 'degraded' });
    expect(buildContainerReadModel(base({ ingestLagMs: 5_000 }))).toMatchObject({ hooksBlind: false, health: 'healthy' });
  });
  test('a restarted container or failed A2A task is degraded', () => {
    expect(buildContainerReadModel(base({ container: c({ restartCount: 1 }) })).health).toBe('degraded');
    expect(buildContainerReadModel(base({ a2aState: 'FAILED', ledgerTerminal: true })).health).toBe('degraded');
  });
  test('missing container with a live task is failed', () => {
    expect(buildContainerReadModel(base({ container: undefined }))).toMatchObject({ containerState: 'missing', health: 'unknown', divergence: 'container_dead_task_live' });
  });
});
