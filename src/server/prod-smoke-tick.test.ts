import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '../shared/contracts/messages.js';
import { buildAlertArtifact, mergeAlertArtifact } from './prod-smoke.js';
import type { AlertArtifact, CheckResult, SmokeConfig } from './prod-smoke.js';
import {
  DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS,
  ProdSmokeTick,
  PROD_SMOKE_TICK_ALERT_KEY,
  PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION,
  buildProdSmokeTickHealthSnapshot,
  createProdSmokeTickFromEnv,
  prodSmokeTickAlertPath,
  resolveProdSmokeTickSettings,
  type ProdSmokeTickDeps,
} from './prod-smoke-tick.js';

// ---------------------------------------------------------------------------
// Fixtures + harness.
// ---------------------------------------------------------------------------

const HEALTHY: CheckResult[] = [
  { name: 'ready', ok: true, detail: 'ok' },
  { name: 'health', ok: true, detail: 'ok' },
  { name: 'tasks-latency', ok: true, detail: 'ok' },
  { name: 'version-probe', ok: true, detail: 'skipped' },
  { name: 'log-continuity', ok: true, detail: 'skipped' },
];

const WEDGED_HEALTH: CheckResult[] = [
  { name: 'ready', ok: true, detail: 'ok' },
  { name: 'health', ok: false, detail: 'http://127.0.0.1:4800/api/health did not respond within 10.0s: timed out' },
  { name: 'tasks-latency', ok: true, detail: 'ok' },
  { name: 'version-probe', ok: true, detail: 'skipped' },
  { name: 'log-continuity', ok: true, detail: 'skipped' },
];

function stubConfig(overrides: Partial<SmokeConfig> = {}): SmokeConfig {
  return {
    healthUrl: 'http://127.0.0.1:4800/api/health',
    readyUrl: 'http://127.0.0.1:4800/api/ready',
    tasksUrl: 'http://127.0.0.1:4800/api/tasks?limit=1',
    logFile: '/tmp/does-not-exist/server.log',
    alertPath: '/tmp/does-not-exist/prod-smoke-alert.json',
    authToken: undefined,
    healthMaxTimeMs: 10_000,
    readyMaxTimeMs: 5_000,
    tasksLatencyBoundMs: 3_000,
    maxLogGapMs: 7_200_000,
    overallTimeoutMs: 45_000,
    previousLogMtimeMs: 12345,
    bootTimeMs: 0,
    ...overrides,
  };
}

/**
 * Build a tick backed by an in-memory artifact store (so readArtifact sees what
 * writeArtifact wrote), a controllable clock, a broadcast spy, and a silent
 * logger. `intervalMs: 0` disables the cadence gate for multi-run tests.
 */
function makeTick(deps: Partial<ProdSmokeTickDeps> & { runChecks: ProdSmokeTickDeps['runChecks'] }) {
  const store = new Map<string, AlertArtifact>();
  const broadcasts: ServerMessage[] = [];
  const opsEdges: Array<{ kind: string; detail?: string }> = [];
  const alertPath = deps.alertPath ?? '/mem/prod-smoke-tick-alert.json';
  const writes: Array<{ path: string; artifact: AlertArtifact }> = [];
  const tick = new ProdSmokeTick({
    kookrDir: '/mem',
    alertPath,
    intervalMs: 0,
    resolveConfig: () => stubConfig({ alertPath }),
    readArtifact: (p) => store.get(p) ?? null,
    writeArtifact: (p, a) => {
      store.set(p, a);
      writes.push({ path: p, artifact: a });
    },
    broadcast: (m) => broadcasts.push(m),
    noteOpsEdge: (kind, detail) => {
      opsEdges.push(detail !== undefined ? { kind, detail } : { kind });
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    ...deps,
  });
  return { tick, store, broadcasts, writes, alertPath, opsEdges };
}

// ---------------------------------------------------------------------------
// AC1 — a wedged endpoint produces an alert artifact naming the failing check,
// and the cadence is hourly (an alert appears within one hour).
// ---------------------------------------------------------------------------

describe('AC1: wedged /api/health → alert artifact naming the failing check', () => {
  it('writes an alert artifact naming "health" when the health probe fails', async () => {
    const { tick, writes } = makeTick({ runChecks: async () => WEDGED_HEALTH });
    const artifact = await tick.maybeRun();
    expect(artifact?.status).toBe('alert');
    expect(artifact?.failingChecks).toContain('health');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.artifact.status).toBe('alert');
    expect(writes[0]!.artifact.failingChecks).toContain('health');
  });

  it('defaults to an hourly cadence so an alert appears within one hour', () => {
    // The host timer fires at hostIntervalMs; a fresh tick reports the hourly value.
    const { tick } = makeTick({ runChecks: async () => HEALTHY, intervalMs: undefined });
    expect(tick.hostIntervalMs).toBe(60 * 60_000);
    expect(tick.hostIntervalMs).toBe(DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS);
  });

  it('broadcasts a fired operational alert with a stable dedup key', async () => {
    const { tick, broadcasts } = makeTick({ runChecks: async () => WEDGED_HEALTH });
    await tick.maybeRun();
    expect(broadcasts).toHaveLength(1);
    const msg = broadcasts[0]!;
    expect(msg.type).toBe('alert');
    if (msg.type === 'alert') {
      expect(msg.operationalAlert?.key).toBe(PROD_SMOKE_TICK_ALERT_KEY);
      expect(msg.operationalAlert?.state).toBe('fired');
      expect(msg.summary).toContain('health');
    }
  });

  it('notes smoke_tick_fire with failingChecks detail on the fire edge (issue #2032)', async () => {
    const { tick, opsEdges } = makeTick({ runChecks: async () => WEDGED_HEALTH });
    await tick.maybeRun();
    expect(opsEdges).toEqual([{ kind: 'smoke_tick_fire', detail: 'health' }]);
  });
});

// ---------------------------------------------------------------------------
// AC2 — structurally impossible for a tick to PASS while a bounded /api/health
// probe would time out. Two facets: (a) any failing check ⇒ alert, never ok;
// (b) a hung check set is force-failed by the overall deadline, not passed.
// ---------------------------------------------------------------------------

describe('AC2: a tick cannot pass while /api/health would time out', () => {
  it('never yields an ok artifact when the health check is failing', async () => {
    const { tick } = makeTick({ runChecks: async () => WEDGED_HEALTH });
    const artifact = await tick.maybeRun();
    expect(artifact?.status).not.toBe('ok');
    expect(artifact?.status).toBe('alert');
  });

  it('force-fails via the overall deadline when the checks never settle', async () => {
    // runChecks that hangs forever — models a probe that escapes its own bound.
    const hang = () => new Promise<CheckResult[]>(() => {});
    const { tick, writes } = makeTick({
      runChecks: hang,
      resolveConfig: () => stubConfig({ overallTimeoutMs: 30, alertPath: '/mem/prod-smoke-tick-alert.json' }),
    });
    const artifact = await tick.maybeRun();
    expect(artifact?.status).toBe('alert');
    expect(artifact?.failingChecks).toContain('overall-timeout');
    expect(writes).toHaveLength(1);
  });

  // End-to-end (facet a): the DEFAULT runChecks — the real runSmokeChecks with
  // bounded fetch(AbortSignal.timeout) — must turn a hung /api/health into a
  // failing `health` check, never a pass. Uses a real HTTP server that answers
  // /api/ready and /api/tasks instantly but hangs /api/health.
  it('turns a real hung /api/health into a failing health check (no seam)', async () => {
    const openSockets: Array<{ destroy: () => void }> = [];
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/api/health')) {
        openSockets.push(req.socket); // never respond → client-side timeout aborts
        return;
      }
      if (req.url?.startsWith('/api/tasks')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ready":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const writes: AlertArtifact[] = [];
    try {
      const tick = new ProdSmokeTick({
        kookrDir: '/mem',
        alertPath: '/mem/prod-smoke-tick-alert.json',
        intervalMs: 0,
        // No runChecks / readArtifact seam — exercise the real bounded-fetch path.
        resolveConfig: () =>
          stubConfig({
            healthUrl: `${base}/api/health`,
            readyUrl: `${base}/api/ready`,
            tasksUrl: `${base}/api/tasks?limit=1`,
            healthMaxTimeMs: 300, // health times out fast
            readyMaxTimeMs: 2_000,
            tasksLatencyBoundMs: 2_000,
            overallTimeoutMs: 10_000, // per-check health bound fires first
            logFile: '/does/not/exist/server.log', // version-probe skips
            previousLogMtimeMs: null, // log-continuity skips
          }),
        writeArtifact: (_p, a) => writes.push(a),
        broadcast: () => {},
        logger: { log: () => {}, warn: () => {}, error: () => {} },
      });
      const artifact = await tick.maybeRun();
      expect(artifact?.status).toBe('alert');
      expect(artifact?.failingChecks).toContain('health');
      expect(writes).toHaveLength(1);
    } finally {
      for (const s of openSockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — healthy prod produces no alert and the tick completes within budget.
// ---------------------------------------------------------------------------

describe('AC3: healthy prod → no alert, bounded completion', () => {
  it('writes an ok artifact with a cleared streak and broadcasts nothing', async () => {
    const { tick, broadcasts, writes } = makeTick({ runChecks: async () => HEALTHY });
    const artifact = await tick.maybeRun();
    expect(artifact?.status).toBe('ok');
    expect(artifact?.consecutiveFailures).toBe(0);
    expect(artifact?.failingChecks).toEqual([]);
    expect(broadcasts).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });

  it('resolves within the overall budget even under the deadline path', async () => {
    const hang = () => new Promise<CheckResult[]>(() => {});
    const { tick } = makeTick({
      runChecks: hang,
      resolveConfig: () => stubConfig({ overallTimeoutMs: 40, alertPath: '/mem/prod-smoke-tick-alert.json' }),
    });
    const started = performance.now();
    await tick.maybeRun();
    const elapsed = performance.now() - started;
    // Bounded: comfortably under a second despite the checks never settling.
    expect(elapsed).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// AC4 — repeated consecutive failures update ONE alert artifact instead of one
// per tick, and the operational alert fires once per episode (edge-triggered).
// ---------------------------------------------------------------------------

describe('AC4: repeated failures update one artifact, fire once per episode', () => {
  it('writes to the same path and accumulates the failing streak', async () => {
    let clock = 1_000;
    const { tick, writes, broadcasts, alertPath } = makeTick({
      runChecks: async () => WEDGED_HEALTH,
      now: () => (clock += 3_600_000),
    });

    await tick.maybeRun();
    await tick.maybeRun();
    await tick.maybeRun();

    // One artifact path, updated in place — not three separate artifacts.
    expect(writes).toHaveLength(3);
    expect(new Set(writes.map((w) => w.path))).toEqual(new Set([alertPath]));
    expect(writes[0]!.artifact.consecutiveFailures).toBe(1);
    expect(writes[1]!.artifact.consecutiveFailures).toBe(2);
    expect(writes[2]!.artifact.consecutiveFailures).toBe(3);
    // firstFailedAt is preserved across the streak.
    expect(writes[2]!.artifact.firstFailedAt).toBe(writes[0]!.artifact.generatedAt);

    // Edge-triggered: exactly one "fired" broadcast for the sustained episode.
    const fired = broadcasts.filter((m) => m.type === 'alert' && m.operationalAlert?.state === 'fired');
    expect(fired).toHaveLength(1);
  });

  it('broadcasts a single recovery when the wedge clears', async () => {
    let clock = 1_000;
    let checks: CheckResult[] = WEDGED_HEALTH;
    const { tick, broadcasts, opsEdges } = makeTick({
      runChecks: async () => checks,
      now: () => (clock += 3_600_000),
    });

    await tick.maybeRun(); // fail → fired
    await tick.maybeRun(); // fail → still firing, no new broadcast
    checks = HEALTHY;
    const recovered = await tick.maybeRun(); // recover → recovered broadcast

    expect(recovered?.status).toBe('ok');
    expect(recovered?.consecutiveFailures).toBe(0);
    const fired = broadcasts.filter((m) => m.type === 'alert' && m.operationalAlert?.state === 'fired');
    const rec = broadcasts.filter((m) => m.type === 'alert' && m.operationalAlert?.state === 'recovered');
    expect(fired).toHaveLength(1);
    expect(rec).toHaveLength(1);

    // Ops-status edges track the same fire/clear edge (issue #2032): one fire
    // for the sustained episode, one clear on recover — not one per hourly tick.
    expect(opsEdges).toEqual([
      { kind: 'smoke_tick_fire', detail: 'health' },
      { kind: 'smoke_tick_clear' },
    ]);

    // A subsequent failure starts a NEW episode → a fresh fired broadcast.
    checks = WEDGED_HEALTH;
    await tick.maybeRun();
    expect(broadcasts.filter((m) => m.type === 'alert' && m.operationalAlert?.state === 'fired')).toHaveLength(2);
    expect(opsEdges.filter((e) => e.kind === 'smoke_tick_fire')).toHaveLength(2);
  });

  it('does not note ops edges on sustained failures mid-episode (issue #2032)', async () => {
    let clock = 1_000;
    const { tick, opsEdges } = makeTick({
      runChecks: async () => WEDGED_HEALTH,
      now: () => (clock += 3_600_000),
    });
    await tick.maybeRun();
    await tick.maybeRun();
    await tick.maybeRun();
    expect(opsEdges).toEqual([{ kind: 'smoke_tick_fire', detail: 'health' }]);
  });
});

// ---------------------------------------------------------------------------
// Restart mid-episode: firing is seeded from the durable artifact so a restart
// during an ongoing outage does not re-broadcast a duplicate `fired`.
// ---------------------------------------------------------------------------

describe('restart mid-episode seeds the edge-trigger from the artifact', () => {
  function priorAlert(): AlertArtifact {
    return mergeAlertArtifact(null, buildAlertArtifact(WEDGED_HEALTH, '2026-07-27T00:00:00.000Z'));
  }

  it('does not re-fire when a restart lands on a still-failing episode', async () => {
    let clock = 1_000;
    const prior = priorAlert(); // status: alert, from before the "restart"
    const { tick, broadcasts, writes } = makeTick({
      runChecks: async () => WEDGED_HEALTH,
      readArtifact: () => prior,
      now: () => (clock += 3_600_000),
    });
    await tick.maybeRun();
    // The artifact continues the streak (2), but no NEW fired broadcast fires.
    expect(writes[0]!.artifact.consecutiveFailures).toBe(2);
    expect(broadcasts.filter((m) => m.type === 'alert' && m.operationalAlert?.state === 'fired')).toHaveLength(0);
  });

  it('emits exactly one recovery when the wedge cleared during the restart', async () => {
    let clock = 1_000;
    const prior = priorAlert();
    const { tick, broadcasts } = makeTick({
      runChecks: async () => HEALTHY,
      readArtifact: () => prior,
      now: () => (clock += 3_600_000),
    });
    const artifact = await tick.maybeRun();
    expect(artifact?.status).toBe('ok');
    expect(broadcasts.filter((m) => m.type === 'alert' && m.operationalAlert?.state === 'recovered')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pile-up guard + cadence gate + robustness.
// ---------------------------------------------------------------------------

describe('pile-up guard and cadence gate', () => {
  it('skips a concurrent run while a previous tick is still in flight', async () => {
    let release!: (checks: CheckResult[]) => void;
    const gate = new Promise<CheckResult[]>((resolve) => {
      release = resolve;
    });
    const runChecks = vi.fn(() => gate);
    const { tick } = makeTick({ runChecks });

    const first = tick.maybeRun(); // starts, blocks on the gate
    const second = await tick.maybeRun(); // must short-circuit, not re-enter
    expect(second).toBeNull();
    expect(runChecks).toHaveBeenCalledTimes(1);

    release(HEALTHY);
    await first;
    expect(runChecks).toHaveBeenCalledTimes(1);
  });

  it('does not drop every other on-grid fire when a run takes real time (regression)', async () => {
    // The host setInterval fires ~intervalMs apart; time also passes DURING each
    // run. If the cadence were anchored to run-END, the next on-grid fire would
    // fall runDuration short of the threshold and be skipped — halving the
    // cadence. Anchoring to the fire START keeps every scheduled fire.
    const INTERVAL = 3_600_000;
    const RUN_DURATION = 5_000; // > CADENCE_TOLERANCE_MS, so an end-anchor WOULD skip
    let clock = 0;
    const runChecks = vi.fn(async () => {
      clock += RUN_DURATION; // wall time advances while the checks run
      return HEALTHY;
    });
    const tick = new ProdSmokeTick({
      kookrDir: '/mem',
      alertPath: '/mem/prod-smoke-tick-alert.json',
      intervalMs: INTERVAL,
      resolveConfig: () => stubConfig(),
      readArtifact: () => null,
      writeArtifact: () => {},
      now: () => clock,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      runChecks,
    });

    clock = 0;
    await tick.maybeRun(); // fire 1 at grid 0
    clock = INTERVAL; // host fires one interval after fire 1 started
    await tick.maybeRun(); // fire 2 — must NOT be skipped
    clock = 2 * INTERVAL;
    await tick.maybeRun(); // fire 3

    expect(runChecks).toHaveBeenCalledTimes(3);
  });

  it('skips a run that fires again before the interval elapses', async () => {
    const runChecks = vi.fn(async () => HEALTHY);
    // Fixed clock + a 1h interval: the second call is inside the window.
    const { tick } = makeTick({ runChecks, intervalMs: 3_600_000, now: () => 5_000 });
    await tick.maybeRun();
    const second = await tick.maybeRun();
    expect(second).toBeNull();
    expect(runChecks).toHaveBeenCalledTimes(1);
  });

  it('never throws when the checks reject — swallows and returns null', async () => {
    const errors: unknown[] = [];
    const { tick } = makeTick({
      runChecks: async () => {
        throw new Error('boom');
      },
      logger: { log: () => {}, warn: () => {}, error: (...a) => errors.push(a) },
    });
    await expect(tick.maybeRun()).resolves.toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Env resolution + factory.
// ---------------------------------------------------------------------------

describe('resolveProdSmokeTickSettings', () => {
  it('is enabled by default only on the canonical prod port 4800', () => {
    expect(resolveProdSmokeTickSettings({}, 4800).enabled).toBe(true);
    expect(resolveProdSmokeTickSettings({}, 4801).enabled).toBe(false);
    expect(resolveProdSmokeTickSettings({}, '4800').enabled).toBe(true);
  });

  it('honours the explicit on/off flag regardless of port', () => {
    expect(resolveProdSmokeTickSettings({ KOOKR_PROD_SMOKE_TICK: '0' }, 4800).enabled).toBe(false);
    expect(resolveProdSmokeTickSettings({ KOOKR_PROD_SMOKE_TICK: 'false' }, 4800).enabled).toBe(false);
    expect(resolveProdSmokeTickSettings({ KOOKR_PROD_SMOKE_TICK: '1' }, 4801).enabled).toBe(true);
    expect(resolveProdSmokeTickSettings({ KOOKR_PROD_SMOKE_TICK: 'true' }, 9999).enabled).toBe(true);
  });

  it('overrides the interval from minutes and disables on a non-positive value', () => {
    expect(resolveProdSmokeTickSettings({ KOOKR_PROD_SMOKE_TICK_INTERVAL_MINUTES: '15' }, 4800).intervalMs).toBe(
      15 * 60_000,
    );
    const disabled = resolveProdSmokeTickSettings({ KOOKR_PROD_SMOKE_TICK_INTERVAL_MINUTES: '0' }, 4800);
    expect(disabled.enabled).toBe(false);
    expect(resolveProdSmokeTickSettings({ KOOKR_PROD_SMOKE_TICK_INTERVAL_MINUTES: '-5' }, 4800).enabled).toBe(false);
  });

  it('falls back to the default cadence (not dark) on a malformed interval value', () => {
    const warns: unknown[] = [];
    const logger = { warn: (...a: unknown[]) => warns.push(a) };
    // A typo must NOT silently disable a monitoring feature — warn + default.
    const result = resolveProdSmokeTickSettings({ KOOKR_PROD_SMOKE_TICK_INTERVAL_MINUTES: '60m' }, 4800, logger);
    expect(result.enabled).toBe(true);
    expect(result.intervalMs).toBe(DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS);
    expect(warns.length).toBe(1);
  });

  it('defaults to the hourly interval when unset', () => {
    expect(resolveProdSmokeTickSettings({}, 4800).intervalMs).toBe(DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS);
  });
});

describe('createProdSmokeTickFromEnv', () => {
  it('returns undefined when disabled', () => {
    expect(createProdSmokeTickFromEnv({ env: {}, port: 4801, kookrDir: '/mem' })).toBeUndefined();
    expect(
      createProdSmokeTickFromEnv({ env: { KOOKR_PROD_SMOKE_TICK: '0' }, port: 4800, kookrDir: '/mem' }),
    ).toBeUndefined();
  });

  it('returns a configured tick when enabled', () => {
    const tick = createProdSmokeTickFromEnv({ env: {}, port: 4800, kookrDir: '/data/.kookr' });
    expect(tick).toBeInstanceOf(ProdSmokeTick);
    expect(tick?.alertArtifactPath).toBe(prodSmokeTickAlertPath('/data/.kookr'));
    expect(tick?.hostIntervalMs).toBe(DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// Health projection (issue #2031) — artifact read only, never re-runs checks.
// ---------------------------------------------------------------------------

describe('buildProdSmokeTickHealthSnapshot (issue #2031)', () => {
  it('returns a null-safe empty snapshot when no artifact exists', () => {
    expect(buildProdSmokeTickHealthSnapshot(null)).toEqual({
      schemaVersion: PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION,
      status: 'unknown',
      consecutiveFailures: 0,
      failingChecks: [],
    });
  });

  it('projects status, consecutiveFailures, and failingChecks from a failing artifact', () => {
    const artifact = mergeAlertArtifact(
      null,
      buildAlertArtifact(WEDGED_HEALTH, '2026-08-04T10:00:00.000Z'),
    );
    // Simulate a long failing streak as written by mergeAlertArtifact on later ticks.
    const streaked: AlertArtifact = {
      ...artifact,
      consecutiveFailures: 113,
      firstFailedAt: '2026-07-30T12:00:00.000Z',
      failingChecks: ['health', 'ready'],
    };
    expect(buildProdSmokeTickHealthSnapshot(streaked)).toEqual({
      schemaVersion: PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION,
      status: 'alert',
      consecutiveFailures: 113,
      failingChecks: ['health', 'ready'],
      generatedAt: '2026-08-04T10:00:00.000Z',
      firstFailedAt: '2026-07-30T12:00:00.000Z',
    });
  });

  it('projects a healthy artifact with consecutiveFailures 0', () => {
    const artifact = mergeAlertArtifact(
      null,
      buildAlertArtifact(HEALTHY, '2026-08-04T11:00:00.000Z'),
    );
    expect(buildProdSmokeTickHealthSnapshot(artifact)).toEqual({
      schemaVersion: PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION,
      status: 'ok',
      consecutiveFailures: 0,
      failingChecks: [],
      generatedAt: '2026-08-04T11:00:00.000Z',
    });
  });

  it('defaults missing consecutiveFailures to 0 (deploy-gate shape)', () => {
    const raw = buildAlertArtifact(WEDGED_HEALTH, '2026-08-04T10:00:00.000Z');
    // buildAlertArtifact does not set consecutiveFailures; health path must not crash.
    expect(raw.consecutiveFailures).toBeUndefined();
    expect(buildProdSmokeTickHealthSnapshot(raw).consecutiveFailures).toBe(0);
  });
});

describe('ProdSmokeTick.getHealthSnapshot (issue #2031)', () => {
  it('reads the durable artifact without re-running smoke checks', async () => {
    const runChecks = vi.fn(async () => WEDGED_HEALTH);
    const { tick, store, alertPath } = makeTick({ runChecks });

    // No artifact yet → null-safe unknown.
    expect(tick.getHealthSnapshot()).toEqual({
      schemaVersion: PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION,
      status: 'unknown',
      consecutiveFailures: 0,
      failingChecks: [],
    });
    expect(runChecks).not.toHaveBeenCalled();

    await tick.maybeRun();
    expect(runChecks).toHaveBeenCalledTimes(1);

    const snap = tick.getHealthSnapshot();
    expect(snap.status).toBe('alert');
    expect(snap.failingChecks).toContain('health');
    expect(snap.consecutiveFailures).toBe(1);
    // getHealthSnapshot must not re-run checks (second call after maybeRun).
    expect(runChecks).toHaveBeenCalledTimes(1);
    expect(store.get(alertPath)?.status).toBe('alert');
  });
});
