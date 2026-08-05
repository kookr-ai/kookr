import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResourceWatchdogService } from './resource-watchdog-service.js';
import {
  FileResourceWatchdogStateStore,
  emptyResourceWatchdogState,
} from '../core/resource-watchdog-state.js';
import {
  JsonlResourceWatchdogAuditSink,
  MemoryResourceWatchdogAuditSink,
} from '../core/resource-watchdog-audit.js';
import type { ResourceWatchdogConfig } from '../core/resource-watchdog-types.js';
import type { ResourceWatchdogSample } from '../core/resource-watchdog-types.js';
import type { LaunchOpts, LaunchResult } from '../shared/contracts/launch.js';

function baseConfig(overrides: Partial<ResourceWatchdogConfig> = {}): ResourceWatchdogConfig {
  return {
    enabled: true,
    intervalMs: 60_000,
    swapUsedPercentThreshold: 50,
    memAvailableMbFloor: 512,
    processCeiling: 40,
    orphanCeiling: 5,
    throttleMs: 30 * 60 * 1000,
    spawnBudget24h: 4,
    spawnBudgetWindowMs: 24 * 60 * 60 * 1000,
    taskCwd: '/tmp/kookr-repo',
    stateFilePath: '/tmp/rw-state.json',
    auditLogPath: '/tmp/rw-audit.jsonl',
    ...overrides,
  };
}

function healthySample(overrides: Partial<ResourceWatchdogSample> = {}): ResourceWatchdogSample {
  return {
    sampledAt: '2026-07-31T12:00:00.000Z',
    swapUsedPercent: 10,
    memAvailableMb: 4096,
    oomKillTotal: 0,
    processCounts: { claude: 1, grok: 0, codex: 0, dtach: 1 },
    orphanSessionCount: 0,
    terminalLeakCount: 0,
    topConsumers: [],
    ...overrides,
  };
}

describe('ResourceWatchdogService', () => {
  let dir: string;
  let nowMs: number;
  let sample: ResourceWatchdogSample;
  let launches: LaunchOpts[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-svc-'));
    nowMs = Date.parse('2026-07-31T12:00:00.000Z');
    sample = healthySample({ swapUsedPercent: 80 });
    launches = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeService(opts: {
    config?: Partial<ResourceWatchdogConfig>;
    audit?: MemoryResourceWatchdogAuditSink;
    launchImpl?: (opts: LaunchOpts) => Promise<LaunchResult>;
    getStaleDtachCount?: () => number | null;
    pressureWhileDisabledAlerter?: { evaluate: ReturnType<typeof vi.fn> };
  } = {}) {
    const statePath = join(dir, 'resource-watchdog.state.json');
    const config = baseConfig({
      stateFilePath: statePath,
      auditLogPath: join(dir, 'audit.jsonl'),
      ...opts.config,
    });
    const audit = opts.audit ?? new MemoryResourceWatchdogAuditSink();
    const launchTask = opts.launchImpl ?? (async (launchOpts: LaunchOpts) => {
      launches.push(launchOpts);
      return {
        task: { id: `task-${launches.length}` },
        queued: false,
      };
    });
    const service = new ResourceWatchdogService({
      getConfig: () => config,
      sampler: { sample: () => sample },
      stateStore: new FileResourceWatchdogStateStore(statePath),
      auditSink: audit,
      launchTask,
      ...(opts.getStaleDtachCount ? { getStaleDtachCount: opts.getStaleDtachCount } : {}),
      ...(opts.pressureWhileDisabledAlerter
        ? { pressureWhileDisabledAlerter: opts.pressureWhileDisabledAlerter }
        : {}),
      nowMs: () => nowMs,
      nowIso: () => new Date(nowMs).toISOString(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    return { service, audit, statePath, config };
  }

  test('does not spawn when disabled', async () => {
    const { service, audit } = makeService({ config: { enabled: false } });
    await service.runOnce();
    expect(launches).toHaveLength(0);
    expect(service.getHealthSnapshot().enabled).toBe(false);
    expect(service.getHealthSnapshot().lastDecision).toBe('disabled');
    expect(audit.records).toHaveLength(0);
  });

  test('pressureWhileDisabled true when disabled + high dtach (issue #2039)', async () => {
    const { service } = makeService({ config: { enabled: false } });
    await service.runOnce();
    // Still no spawn — visibility only.
    expect(launches).toHaveLength(0);
    const underPressure = service.getHealthSnapshot({ staleDtachCount: 21 });
    expect(underPressure.pressureWhileDisabled).toBe(true);
    expect(underPressure.pressureWhileDisabledReason).toContain('staleProcesses.dtach.count=21');
    expect(underPressure.enabled).toBe(false);

    const lowPressure = service.getHealthSnapshot({ staleDtachCount: 3 });
    expect(lowPressure.pressureWhileDisabled).toBe(false);
    expect(lowPressure.pressureWhileDisabledReason).toBeNull();

    // No gauge → not pressure (unknown, not assumed high).
    const unknown = service.getHealthSnapshot();
    expect(unknown.pressureWhileDisabled).toBe(false);
  });

  test('pressureWhileDisabled false when enabled even with high dtach (issue #2039)', async () => {
    // Healthy sample so we do not spawn and muddy the snapshot.
    sample = healthySample();
    const { service } = makeService({ config: { enabled: true } });
    await service.runOnce();
    const snap = service.getHealthSnapshot({ staleDtachCount: 99 });
    expect(snap.enabled).toBe(true);
    expect(snap.pressureWhileDisabled).toBe(false);
    expect(snap.pressureWhileDisabledReason).toBeNull();
  });

  test('disabled-under-pressure alerter pages when pressure stays true (issue #2078)', async () => {
    const evaluate = vi.fn();
    const getStaleDtachCount = vi.fn(() => 32);
    const { service } = makeService({
      config: { enabled: false },
      getStaleDtachCount,
      pressureWhileDisabledAlerter: { evaluate },
    });
    await service.runOnce();
    expect(launches).toHaveLength(0);
    expect(getStaleDtachCount).toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledWith({
      pressureWhileDisabled: true,
      reason: expect.stringContaining('staleProcesses.dtach.count=32'),
      dtachCount: 32,
    });
  });

  test('disabled-under-pressure alerter clears when enabled (issue #2078)', async () => {
    sample = healthySample();
    const evaluate = vi.fn();
    const getStaleDtachCount = vi.fn(() => 99);
    const { service } = makeService({
      config: { enabled: true },
      getStaleDtachCount,
      pressureWhileDisabledAlerter: { evaluate },
    });
    await service.runOnce();
    // When enabled, skip the gauge read and report pressure=false so the
    // alerter can clear any prior episode.
    expect(getStaleDtachCount).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledWith({
      pressureWhileDisabled: false,
      reason: null,
      dtachCount: null,
    });
  });

  test('disabled-under-pressure alerter never spawns investigation (issue #2078)', async () => {
    const evaluate = vi.fn();
    const { service } = makeService({
      config: { enabled: false },
      getStaleDtachCount: () => 100,
      pressureWhileDisabledAlerter: { evaluate },
    });
    await service.runOnce();
    await service.runOnce();
    expect(launches).toHaveLength(0);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls.every((c) => c[0].pressureWhileDisabled === true)).toBe(true);
  });

  test('spawns investigation with hard-rules prompt on pressure', async () => {
    const audit = new MemoryResourceWatchdogAuditSink();
    const { service } = makeService({ audit });
    await service.runOnce();
    expect(launches).toHaveLength(1);
    expect(launches[0]?.name).toBe('Resource watchdog investigation');
    expect(launches[0]?.unattended).toBe(true);
    expect(launches[0]?.launchActorId).toBe('kookr');
    expect(launches[0]?.launchSource).toBe('api');
    expect(launches[0]?.disableDedup).toBe(true);
    expect(launches[0]?.prompt).toContain('NO INTERACTIVE PROMPTS');
    expect(launches[0]?.prompt).toContain('REVERSIBLE REMEDIATION ONLY');
    expect(audit.records.map((r) => r.action)).toEqual(['trigger', 'spawn']);
    expect(service.getHealthSnapshot().lastSpawnTaskId).toBe('task-1');
    expect(service.getHealthSnapshot().spawnsIn24h).toBe(1);
  });

  test('30-min throttle suppresses second spawn and emits audit', async () => {
    const audit = new MemoryResourceWatchdogAuditSink();
    const { service } = makeService({ audit });
    await service.runOnce();
    expect(launches).toHaveLength(1);

    nowMs += 5 * 60 * 1000;
    sample = healthySample({
      sampledAt: new Date(nowMs).toISOString(),
      swapUsedPercent: 90,
    });
    await service.runOnce();
    expect(launches).toHaveLength(1);
    expect(audit.records.some((r) => r.action === 'suppress_throttled')).toBe(true);
    expect(service.getHealthSnapshot().throttleOpen).toBe(false);
  });

  test('throttle persists across service restart (state file)', async () => {
    const { service, statePath } = makeService();
    await service.runOnce();
    expect(launches).toHaveLength(1);
    expect(existsSync(statePath)).toBe(true);

    nowMs += 5 * 60 * 1000;
    sample = healthySample({
      sampledAt: new Date(nowMs).toISOString(),
      swapUsedPercent: 95,
    });
    // New service instance loads the same state file.
    const { service: restarted } = makeService();
    await restarted.runOnce();
    expect(launches).toHaveLength(1); // no new launch
    expect(restarted.getHealthSnapshot().throttleOpen).toBe(false);
  });

  test('oom_kill delta triggers immediate spawn', async () => {
    sample = healthySample({ oomKillTotal: 0, swapUsedPercent: 0 });
    const { service } = makeService();
    await service.runOnce(); // baseline, no pressure
    expect(launches).toHaveLength(0);

    sample = healthySample({
      sampledAt: '2026-07-31T12:01:00.000Z',
      oomKillTotal: 1,
      swapUsedPercent: 0,
    });
    await service.runOnce();
    expect(launches).toHaveLength(1);
    expect(launches[0]?.prompt).toContain('oom_kill');
  });

  test('24h budget switches to meta_reflection', async () => {
    const audit = new MemoryResourceWatchdogAuditSink();
    // Pre-seed four prior spawns outside throttle window but inside 24h.
    const statePath = join(dir, 'resource-watchdog.state.json');
    const seedStore = new FileResourceWatchdogStateStore(statePath);
    const stamps = [0, 1, 2, 3].map((i) =>
      new Date(nowMs - (6 - i) * 60 * 60 * 1000).toISOString(),
    );
    seedStore.save({
      ...emptyResourceWatchdogState(),
      spawnTimestamps: stamps,
      lastSpawnAt: stamps[3]!,
      lastSpawnKind: 'investigation',
      lastSpawnTaskId: 'old',
      lastTriggerAt: stamps[3]!,
      lastTriggerReasons: ['swap_percent'],
      lastMetaReflectionAt: null,
    });

    const config = baseConfig({
      stateFilePath: statePath,
      auditLogPath: join(dir, 'audit.jsonl'),
    });
    const service = new ResourceWatchdogService({
      getConfig: () => config,
      sampler: { sample: () => sample },
      stateStore: new FileResourceWatchdogStateStore(statePath),
      auditSink: audit,
      launchTask: async (opts) => {
        launches.push(opts);
        return { task: { id: 'meta-1' }, queued: false };
      },
      nowMs: () => nowMs,
      nowIso: () => new Date(nowMs).toISOString(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await service.runOnce();
    expect(launches).toHaveLength(1);
    expect(launches[0]?.name).toBe('Resource watchdog meta-reflection');
    expect(launches[0]?.prompt).toContain('meta-reflection');
    expect(service.getHealthSnapshot().lastSpawnKind).toBe('meta_reflection');
  });

  test('spawn_failed is audited when launch throws (backpressure) and still arms throttle', async () => {
    const audit = new MemoryResourceWatchdogAuditSink();
    const { service } = makeService({
      audit,
      launchImpl: async () => {
        throw new Error('pending_queue_full');
      },
    });
    await service.runOnce();
    expect(audit.records.map((r) => r.action)).toEqual(['trigger', 'spawn_failed']);
    expect(service.getHealthSnapshot().lastSpawnTaskId).toBeNull();
    // Throttle must arm on failure so a saturated host does not retry every interval.
    expect(service.getHealthSnapshot().throttleOpen).toBe(false);
    expect(service.getHealthSnapshot().spawnsIn24h).toBe(1);

    nowMs += 5 * 60 * 1000;
    sample = healthySample({
      sampledAt: new Date(nowMs).toISOString(),
      swapUsedPercent: 95,
    });
    await service.runOnce();
    expect(launches).toHaveLength(0);
    expect(audit.records.some((r) => r.action === 'suppress_throttled')).toBe(true);
  });

  test('JSONL audit sink emits a line for spawn', async () => {
    const auditPath = join(dir, 'resource-watchdog-audit.jsonl');
    const statePath = join(dir, 'state.json');
    const config = baseConfig({ stateFilePath: statePath, auditLogPath: auditPath });
    const service = new ResourceWatchdogService({
      getConfig: () => config,
      sampler: { sample: () => sample },
      stateStore: new FileResourceWatchdogStateStore(statePath),
      auditSink: new JsonlResourceWatchdogAuditSink(auditPath),
      launchTask: async () => ({ task: { id: 't1' }, queued: false }),
      nowMs: () => nowMs,
      nowIso: () => new Date(nowMs).toISOString(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await service.runOnce();
    // JsonlResourceWatchdogAuditSink appends are fire-and-forget (queued Promise).
    // Under full-suite load a fixed 50ms sleep races; poll until the spawn line lands.
    const deadline = Date.now() + 2_000;
    let text = '';
    while (Date.now() < deadline) {
      if (existsSync(auditPath)) {
        text = readFileSync(auditPath, 'utf-8');
        if (text.includes('"action":"spawn"')) break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(text).toContain('"action":"spawn"');
    expect(text).toContain('resource-watchdog-audit.v1');
  });
});
