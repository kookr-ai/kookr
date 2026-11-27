import { describe, expect, test } from 'vitest';
import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { FleetVitalsSample } from '../shared/contracts/fleet-vitals.js';
import type { GpuDeviceReading } from '../core/gpu-metrics.js';
import {
  FleetVitalsService,
  type FleetVitalsLiveTask,
} from './fleet-vitals-service.js';
import type { GpuProbeSnapshot } from './gpu-probe.js';

const GIB = 1024 ** 3;

function resourceStatus(overrides: {
  cpu?: number | null;
  memoryUsedPercent?: number | null;
  memoryFreeBytes?: number | null;
  memoryTotalBytes?: number | null;
  loopMs?: number | null;
} = {}): SystemResourceStatus {
  const pick = <T>(key: keyof typeof overrides, fallback: T): T =>
    (key in overrides ? overrides[key] : fallback) as T;
  return {
    source: { kind: 'server-host' },
    sampledAt: '2026-11-27T18:00:00.000Z',
    sampleGapMs: 2_000,
    timerDriftMs: 0,
    host: {
      cpuUsagePercent: pick('cpu', 66),
      memoryUsedPercent: pick('memoryUsedPercent', 32),
      memoryFreeBytes: pick('memoryFreeBytes', 21 * GIB),
      memoryTotalBytes: pick('memoryTotalBytes', 31 * GIB),
      dataDirectory: { path: null, diskFreeBytes: null, diskTotalBytes: null, diskFreePercent: null },
    },
    server: {
      eventLoopDelayP95Ms: pick('loopMs', 123),
      processRssBytes: 900_000_000,
      processHeapUsedBytes: 1,
      processHeapTotalBytes: 2,
    },
    unavailable: [],
  };
}

const RTX: GpuDeviceReading = {
  index: 0,
  name: 'NVIDIA GeForce RTX 3090',
  utilizationPercent: 24,
  memoryUsedBytes: 2.4 * GIB,
  memoryTotalBytes: 24 * GIB,
  temperatureC: 47,
  powerWatts: 32,
};

function task(id: string, outputTokens: number, cacheReadTokens = 0): FleetVitalsLiveTask {
  return { id, tokens: { inputTokens: 0, outputTokens, cacheReadTokens, cacheWriteTokens: 0 } };
}

interface Harness {
  service: FleetVitalsService;
  sent: FleetVitalsSample[];
  advance(ms: number): void;
  tick(status?: SystemResourceStatus): FleetVitalsSample;
  setTasks(tasks: FleetVitalsLiveTask[]): void;
  setSubagents(count: number): void;
  setGpu(snapshot: GpuProbeSnapshot): void;
  gpuRefreshes(): number;
}

function harness(options: { historyPoints?: number; isWatched?: () => boolean } = {}): Harness {
  let now = 1_000_000;
  let tasks: FleetVitalsLiveTask[] = [];
  let subagents = 0;
  let gpu: GpuProbeSnapshot = { devices: [RTX], ageMs: 0, unavailable: null };
  let refreshes = 0;
  const sent: FleetVitalsSample[] = [];
  const service = new FleetVitalsService({
    broadcastToAll: (msg: ServerMessage) => {
      if (msg.type === 'fleetVitals') sent.push(msg.sample);
    },
    gpu: {
      refresh: async () => { refreshes += 1; },
      snapshot: () => gpu,
    },
    listLiveTasks: () => tasks,
    countSubagents: () => subagents,
    isWatched: options.isWatched,
    readLoadAverage1m: () => 18.2,
    readLogicalCpuCount: () => 16,
    nowMs: () => now,
    gpuRefreshMs: 4_000,
    historyPoints: options.historyPoints,
    logger: { warn: () => undefined },
  });
  return {
    service,
    sent,
    advance: (ms) => { now += ms; },
    tick: (status = resourceStatus()) => {
      service.observeResourceStatus(status);
      return sent[sent.length - 1];
    },
    setTasks: (next) => { tasks = next; },
    setSubagents: (count) => { subagents = count; },
    setGpu: (snapshot) => { gpu = snapshot; },
    gpuRefreshes: () => refreshes,
  };
}

describe('FleetVitalsService', () => {
  test('builds the machine part from the resource status and the GPU probe', () => {
    const h = harness();
    const sample = h.tick();
    expect(sample.sampledAtMs).toBe(1_000_000);
    expect(sample.machine).toEqual({
      cpuUsagePercent: 66,
      loadAverage1m: 18.2,
      logicalCpuCount: 16,
      memoryUsedPercent: 32,
      memoryUsedBytes: 10 * GIB,
      memoryTotalBytes: 31 * GIB,
      gpu: {
        name: 'NVIDIA GeForce RTX 3090',
        deviceCount: 1,
        utilizationPercent: 24,
        memoryUsedBytes: 2.4 * GIB,
        memoryTotalBytes: 24 * GIB,
        memoryUsedPercent: 10,
        temperatureC: 47,
        powerWatts: 32,
      },
      gpuUnavailable: null,
      serverLoopDelayP95Ms: 123,
    });
  });

  test('a host without a GPU has no gpu block and says why', () => {
    const h = harness();
    h.setGpu({ devices: [], ageMs: null, unavailable: 'not_installed' });
    const sample = h.tick();
    expect(sample.machine.gpu).toBeNull();
    expect(sample.machine.gpuUnavailable).toBe('not_installed');
  });

  test('unmeasured readings stay null instead of becoming zero', () => {
    const h = harness();
    const sample = h.tick(resourceStatus({ cpu: null, memoryUsedPercent: null, memoryFreeBytes: null, loopMs: null }));
    expect(sample.machine.cpuUsagePercent).toBeNull();
    expect(sample.machine.memoryUsedPercent).toBeNull();
    expect(sample.machine.memoryUsedBytes).toBeNull();
    expect(sample.machine.serverLoopDelayP95Ms).toBeNull();
  });

  test('counts live agents and subagents', () => {
    const h = harness();
    h.setTasks([task('a', 0), task('b', 0), { id: 'c', tokens: null }]);
    h.setSubagents(6);
    const sample = h.tick();
    expect(sample.fleet.agents).toBe(3);
    expect(sample.fleet.subagents).toBe(6);
  });

  test('token rates are null on the first sample, then the growth per second', () => {
    const h = harness();
    h.setTasks([task('a', 1_000, 50_000)]);
    expect(h.tick().fleet.tokens).toBeNull();
    h.advance(10_000);
    h.setTasks([task('a', 2_100, 185_000)]);
    expect(h.tick().fleet.tokens).toEqual({
      generatedPerSec: 110,
      readPerSec: 13_500,
      cacheReadPerSec: 13_500,
    });
  });

  test('a task that reports tokens for the first time while running adds no spike', () => {
    const h = harness();
    h.setTasks([{ id: 'a', tokens: null }]);
    h.tick();
    h.advance(10_000);
    // The first usage report carries the whole transcript so far.
    h.setTasks([task('a', 400_000)]);
    expect(h.tick().fleet.tokens?.generatedPerSec).toBe(0);
  });

  test('counts tool calls of the last minute and lists the three busiest tools', () => {
    const h = harness();
    for (let i = 0; i < 18; i++) h.service.noteToolCall('Bash');
    for (let i = 0; i < 4; i++) h.service.noteToolCall('Read');
    h.service.noteToolCall('Write');
    h.service.noteToolCall('Write');
    h.service.noteToolCall('Agent');
    const sample = h.tick();
    expect(sample.fleet.toolCallsPerMin).toBe(25);
    expect(sample.fleet.topTools).toEqual([
      { tool: 'Bash', calls: 18 },
      { tool: 'Read', calls: 4 },
      { tool: 'Write', calls: 2 },
    ]);
    h.advance(61_000);
    const later = h.tick();
    expect(later.fleet.toolCallsPerMin).toBe(0);
    expect(later.fleet.topTools).toEqual([]);
  });

  test('an idle fleet reads zero', () => {
    const h = harness();
    h.tick();
    h.advance(2_000);
    const sample = h.tick();
    expect(sample.fleet).toEqual({
      agents: 0,
      subagents: 0,
      tokens: { generatedPerSec: 0, readPerSec: 0, cacheReadPerSec: 0 },
      toolCallsPerMin: 0,
      topTools: [],
    });
  });

  test('keeps a bounded history, oldest first, one point per sample', () => {
    const h = harness({ historyPoints: 3 });
    for (let i = 0; i < 5; i++) {
      // One more tool call before each sample: 1, 2, 3, 4, 5 in the last minute.
      h.service.noteToolCall('Bash');
      h.tick();
      h.advance(2_000);
    }
    const history = h.service.getHistory();
    expect(history.map((point) => point.tools)).toEqual([3, 4, 5]);
    // Only the series the dashboard draws are kept.
    expect(history[2]).toEqual({ t: 1_008_000, gen: 0, read: 0, tools: 5 });
    // A copy: mutating it does not corrupt the buffer.
    history.length = 0;
    expect(h.service.getHistory()).toHaveLength(3);
  });

  test('held-over resource values are reported as unmeasured, not as current', () => {
    const h = harness();
    // The resource sampler failed: the status carries its last good values, marked stale.
    const held: SystemResourceStatus = {
      ...resourceStatus({ cpu: 40, memoryUsedPercent: 50, loopMs: 12 }),
      stale: { reason: 'sampler_error', lastGoodAt: '2026-11-27T17:59:00.000Z', ageMs: 60_000 },
    };
    const sample = h.tick(held);
    expect(sample.machine.cpuUsagePercent).toBeNull();
    expect(sample.machine.memoryUsedPercent).toBeNull();
    expect(sample.machine.memoryUsedBytes).toBeNull();
    expect(sample.machine.memoryTotalBytes).toBeNull();
    expect(sample.machine.serverLoopDelayP95Ms).toBeNull();
    // Readings that do not come from the resource sampler are still current.
    expect(sample.machine.gpu?.utilizationPercent).toBe(24);
    expect(sample.machine.loadAverage1m).toBe(18.2);
    // The next good sample is shown again.
    expect(h.tick().machine.cpuUsagePercent).toBe(66);
  });

  test('past the cap on distinct tool names a call still counts, only its name is left out', () => {
    const h = harness();
    for (let i = 0; i < 200; i++) h.service.noteToolCall(`mcp__tool_${String(i).padStart(3, '0')}`);
    h.service.noteToolCall('one_too_many');
    h.service.noteToolCall('one_too_many');
    h.service.noteToolCall('mcp__tool_000');
    const sample = h.tick();
    expect(sample.fleet.toolCallsPerMin).toBe(203);
    // A name already tracked keeps counting; the 201st name never enters the mix.
    expect(sample.fleet.topTools[0]).toEqual({ tool: 'mcp__tool_000', calls: 2 });
    expect(sample.fleet.topTools.some((entry) => entry.tool === 'one_too_many')).toBe(false);
  });

  test('getLatest returns the last broadcast sample', () => {
    const h = harness();
    expect(h.service.getLatest()).toBeNull();
    const sample = h.tick();
    expect(h.service.getLatest()).toBe(sample);
  });

  test('refreshes the GPU reading at its own slower pace', () => {
    const h = harness();
    h.tick();
    h.advance(2_000);
    h.tick();
    expect(h.gpuRefreshes()).toBe(1);
    h.advance(2_000);
    h.tick();
    expect(h.gpuRefreshes()).toBe(2);
  });

  test('the GPU command is not run while nobody is watching, and runs at once when someone connects', () => {
    let watched = false;
    const h = harness({ isWatched: () => watched });
    h.tick();
    h.advance(2_000);
    h.tick();
    expect(h.gpuRefreshes()).toBe(0);
    // A skipped probe does not start the four-second wait: the very next sample probes.
    watched = true;
    h.advance(2_000);
    h.tick();
    expect(h.gpuRefreshes()).toBe(1);
    h.advance(2_000);
    h.tick();
    expect(h.gpuRefreshes()).toBe(1);
  });

  test('a throwing source becomes an unavailable reading and the sample still goes out', () => {
    let now = 5_000;
    const sent: FleetVitalsSample[] = [];
    const warnings: unknown[] = [];
    const service = new FleetVitalsService({
      broadcastToAll: (msg) => { if (msg.type === 'fleetVitals') sent.push(msg.sample); },
      gpu: {
        refresh: () => { throw new Error('spawn failed'); },
        snapshot: () => { throw new Error('probe broke'); },
      },
      listLiveTasks: () => { throw new Error('store broke'); },
      countSubagents: () => { throw new Error('monitor broke'); },
      readLoadAverage1m: () => { throw new Error('os broke'); },
      nowMs: () => now,
      logger: { warn: (...args: unknown[]) => { warnings.push(args); } },
    });
    service.observeResourceStatus(resourceStatus());
    now += 2_000;
    service.observeResourceStatus(resourceStatus());
    expect(sent).toHaveLength(2);
    expect(sent[1].machine.gpu).toBeNull();
    expect(sent[1].machine.gpuUnavailable).toBe('probe_failed');
    expect(sent[1].machine.loadAverage1m).toBeNull();
    expect(sent[1].machine.cpuUsagePercent).toBe(66);
    expect(sent[1].fleet.agents).toBe(0);
    expect(sent[1].fleet.subagents).toBe(0);
    // Logged once, not on every tick.
    expect(warnings).toHaveLength(1);
  });
});
