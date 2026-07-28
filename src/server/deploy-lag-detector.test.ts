import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { type AlertArtifact, buildAlertArtifact } from './prod-smoke.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  buildDeployLagAlertMessage,
  createDeployLagDetectorFromEnv,
  createKookrTargetResolver,
  createLucyTargetResolver,
  deployLagAlertPath,
  DeployLagDetector,
  type DeployLagTarget,
  resolveDeployLagDetectorSettings,
  type DeployLagTargetResolver,
} from './deploy-lag-detector.js';
import {
  DEFAULT_DEPLOY_LAG_THRESHOLD_MS,
  type DeployLagTargetSnapshot,
  type GitReader,
} from './deploy-lag.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

/** In-memory artifact store standing in for the durable JSON file. */
function memoryArtifactStore() {
  let stored: AlertArtifact | null = null;
  const paths: string[] = [];
  return {
    read: (_path: string) => stored,
    write: (path: string, artifact: AlertArtifact) => {
      paths.push(path);
      stored = artifact;
    },
    get: () => stored,
    writtenPaths: () => paths,
  };
}

function laggingSnapshot(target: string, oldestAgeMs = 7 * HOUR_MS): DeployLagTargetSnapshot {
  return {
    target,
    deployedSha: 'a'.repeat(40),
    mainSha: 'b'.repeat(40),
    pendingCommits: [{ shortSha: '2437099', committedAtMs: NOW - oldestAgeMs, subject: 'fix: deprecated model' }],
  };
}

function target(name: string, resolve: DeployLagTargetResolver): DeployLagTarget {
  return { name, resolve };
}

const laggingTarget = (name: string, ageMs = 7 * HOUR_MS): DeployLagTarget =>
  target(name, async () => laggingSnapshot(name, ageMs));
const healthyTarget = (name: string): DeployLagTarget =>
  target(name, async () => ({ target: name, deployedSha: 'c'.repeat(40), mainSha: 'c'.repeat(40), pendingCommits: [] }));
const unknownTarget = (name: string): DeployLagTarget =>
  target(name, async () => ({
    target: name,
    deployedSha: null,
    mainSha: 'b'.repeat(40),
    pendingCommits: [],
    unavailableReason: 'transient git failure',
  }));

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeDetector(
  targets: DeployLagTarget[],
  store = memoryArtifactStore(),
  broadcast?: (m: ServerMessage) => void,
) {
  const detector = new DeployLagDetector({
    kookrDir: '/tmp/kookr',
    targets,
    now: () => NOW,
    readArtifact: store.read,
    writeArtifact: store.write,
    logger: silentLogger,
    ...(broadcast ? { broadcast } : {}),
  });
  return { detector, store };
}

describe('DeployLagDetector.maybeRun', () => {
  it('AC1: reproducing the lucy #1653 state raises an alert naming the pending commits (artifact + broadcast)', async () => {
    const broadcasts: ServerMessage[] = [];
    const { detector, store } = makeDetector([laggingTarget('lucy')], memoryArtifactStore(), (m) => broadcasts.push(m));
    const artifact = await detector.maybeRun();
    expect(artifact?.status).toBe('alert');
    expect(artifact?.failingChecks).toContain('deploy-lag:lucy');
    const lucyCheck = artifact?.checks.find((c) => c.name === 'deploy-lag:lucy');
    expect(lucyCheck?.detail).toContain('2437099 fix: deprecated model');
    expect(store.get()?.status).toBe('alert');
    // The operator-facing broadcast itself carries the pending commit names,
    // the critical severity, and the dedup key — not just the persisted artifact.
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.severity).toBe('critical');
    expect(broadcasts[0]?.details).toContain('2437099 fix: deprecated model');
    expect(broadcasts[0]?.operationalAlert).toMatchObject({ key: 'deploy:lag', state: 'fired' });
  });

  it('AC2: a kookr checkout pinned behind origin/main raises an alert', async () => {
    const { detector } = makeDetector([laggingTarget('kookr', 8 * HOUR_MS)]);
    const artifact = await detector.maybeRun();
    expect(artifact?.status).toBe('alert');
    expect(artifact?.failingChecks).toEqual(['deploy-lag:kookr']);
  });

  it('AC3: a freshly merged commit under the threshold raises no alert', async () => {
    const broadcasts: ServerMessage[] = [];
    const { detector, store } = makeDetector([laggingTarget('kookr', 1 * HOUR_MS)], memoryArtifactStore(), (m) =>
      broadcasts.push(m),
    );
    const artifact = await detector.maybeRun();
    expect(artifact?.status).toBe('ok');
    expect(store.get()?.status).toBe('ok');
    expect(broadcasts).toHaveLength(0);
  });

  it('AC5: a persisting lag updates ONE artifact file on disk (real read/write)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-lag-'));
    try {
      let clock = NOW;
      const broadcasts: ServerMessage[] = [];
      const detector = new DeployLagDetector({
        kookrDir: dir,
        targets: [laggingTarget('lucy')],
        intervalMs: HOUR_MS,
        now: () => clock,
        broadcast: (m) => broadcasts.push(m),
        logger: silentLogger,
        // NOTE: no readArtifact/writeArtifact override — exercises the real
        // durable JSON read/write against a throwaway dir, proving path identity.
      });

      const first = await detector.maybeRun();
      expect(first?.consecutiveFailures).toBe(1);
      const firstFailedAt = first?.firstFailedAt;

      clock += HOUR_MS;
      const second = await detector.maybeRun();
      expect(second?.consecutiveFailures).toBe(2);
      expect(second?.firstFailedAt).toBe(firstFailedAt);

      clock += HOUR_MS;
      const third = await detector.maybeRun();
      expect(third?.consecutiveFailures).toBe(3);

      // Exactly ONE artifact file after three lagging ticks (AC5) …
      expect(readdirSync(dir)).toEqual(['deploy-lag-alert.json']);
      expect(detector.alertArtifactPath).toBe(deployLagAlertPath(dir));
      // … and exactly one fired broadcast (dedup, no per-tick refile).
      expect(broadcasts.filter((b) => b.operationalAlert?.state === 'fired')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a single recovered broadcast when the lag genuinely clears', async () => {
    const broadcasts: ServerMessage[] = [];
    let clock = NOW;
    const store = memoryArtifactStore();
    let phase: 'lagging' | 'healthy' = 'lagging';
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [target('lucy', async () => (phase === 'lagging' ? laggingSnapshot('lucy') : (await healthyTarget('lucy').resolve())))],
      intervalMs: HOUR_MS,
      now: () => clock,
      readArtifact: store.read,
      writeArtifact: store.write,
      broadcast: (m) => broadcasts.push(m),
      logger: silentLogger,
    });

    await detector.maybeRun();
    clock += HOUR_MS;
    phase = 'healthy';
    const recovered = await detector.maybeRun();
    expect(recovered?.status).toBe('ok');
    expect(broadcasts.filter((b) => b.operationalAlert?.state === 'recovered')).toHaveLength(1);
  });

  it('a transient unknown during an active alert HOLDS the episode — never a false "recovered"', async () => {
    const broadcasts: ServerMessage[] = [];
    let clock = NOW;
    const store = memoryArtifactStore();
    let phase: 'lagging' | 'unknown' | 'lagging-again' = 'lagging';
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [
        target('lucy', async () =>
          phase === 'unknown' ? (await unknownTarget('lucy').resolve()) : laggingSnapshot('lucy'),
        ),
      ],
      intervalMs: HOUR_MS,
      now: () => clock,
      readArtifact: store.read,
      writeArtifact: store.write,
      broadcast: (m) => broadcasts.push(m),
      logger: silentLogger,
    });

    const fired = await detector.maybeRun(); // lagging → fire
    expect(fired?.status).toBe('alert');

    clock += HOUR_MS;
    phase = 'unknown';
    const held = await detector.maybeRun(); // git blip → unknown → HOLD (not cleared)
    expect(held?.status).toBe('alert'); // still the active alert, not 'ok'

    clock += HOUR_MS;
    phase = 'lagging-again';
    await detector.maybeRun(); // lagging again → still firing, no re-broadcast

    expect(broadcasts.filter((b) => b.operationalAlert?.state === 'fired')).toHaveLength(1);
    expect(broadcasts.filter((b) => b.operationalAlert?.state === 'recovered')).toHaveLength(0);
  });

  it('AC4: the detector never triggers a deploy — only reads + one broadcast per edge', async () => {
    let resolverCalls = 0;
    const store = memoryArtifactStore();
    const broadcasts: ServerMessage[] = [];
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [
        target('kookr', async () => {
          resolverCalls++;
          return laggingSnapshot('kookr');
        }),
      ],
      now: () => NOW,
      readArtifact: store.read,
      writeArtifact: store.write,
      broadcast: (m) => broadcasts.push(m),
      logger: silentLogger,
    });
    await detector.maybeRun();
    expect(resolverCalls).toBe(1);
    expect(broadcasts).toHaveLength(1); // an alert, never a deploy action
  });

  it('honours the cadence gate and the pile-up guard', async () => {
    let clock = NOW;
    let calls = 0;
    const store = memoryArtifactStore();
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [
        target('kookr', async () => {
          calls++;
          return healthyTarget('kookr').resolve();
        }),
      ],
      intervalMs: HOUR_MS,
      now: () => clock,
      readArtifact: store.read,
      writeArtifact: store.write,
      logger: silentLogger,
    });
    await detector.maybeRun(); // runs
    await detector.maybeRun(); // skipped: too soon
    expect(calls).toBe(1);
    clock += HOUR_MS;
    await detector.maybeRun(); // runs again
    expect(calls).toBe(2);
  });

  it('a resolver that hangs past the deadline degrades to a NAMED unknown (no false alert)', async () => {
    const store = memoryArtifactStore();
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [target('lucy', () => new Promise<DeployLagTargetSnapshot>(() => {}))], // never settles
      overallTimeoutMs: 20,
      now: () => NOW,
      readArtifact: store.read,
      writeArtifact: store.write,
      logger: silentLogger,
    });
    const artifact = await detector.maybeRun();
    expect(artifact?.status).toBe('ok'); // unknown is non-alerting
    expect(artifact?.checks[0]?.name).toBe('deploy-lag:lucy'); // identity preserved
    expect(artifact?.checks[0]?.detail).toContain('deadline');
  });

  it('a throwing resolver is caught as a NAMED unknown, never crashing the tick', async () => {
    const store = memoryArtifactStore();
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [
        target('kookr', async () => {
          throw new Error('git blew up');
        }),
      ],
      now: () => NOW,
      readArtifact: store.read,
      writeArtifact: store.write,
      logger: silentLogger,
    });
    const artifact = await detector.maybeRun();
    expect(artifact?.status).toBe('ok');
    expect(artifact?.checks[0]?.name).toBe('deploy-lag:kookr');
    expect(artifact?.checks[0]?.detail).toContain('git blew up');
  });
});

describe('DeployLagDetector live-verified flip (issue #1596)', () => {
  const convergedTarget = (name: string, repoPath: string, deployedSha = 'c'.repeat(40)): DeployLagTarget => ({
    name,
    repoPath,
    resolve: async () => ({ target: name, deployedSha, mainSha: deployedSha, pendingCommits: [] }),
  });

  it('fires onDeployVerified on a converged tick with isContained bound to the deployed SHA', async () => {
    const calls: Array<{ sha: string; contained: string[] }> = [];
    // Ancestry stub: only "live" is contained in the deployed SHA.
    const ancestry = vi.fn(async (_repo: string, ancestor: string, _descendant: string) => ancestor === 'live');
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [convergedTarget('kookr', '/repo/kookr')],
      now: () => NOW,
      readArtifact: () => null,
      writeArtifact: () => {},
      logger: silentLogger,
      ancestryChecker: ancestry,
      onDeployVerified: async (sha, isContained) => {
        const contained: string[] = [];
        for (const commit of ['live', 'pending']) {
          if (await isContained(commit)) contained.push(commit);
        }
        calls.push({ sha, contained });
      },
    });

    await detector.maybeRun();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sha).toBe('c'.repeat(40));
    expect(calls[0]?.contained).toEqual(['live']);
    // Ancestry resolved against the target's repo path and the deployed SHA.
    expect(ancestry).toHaveBeenCalledWith('/repo/kookr', 'live', 'c'.repeat(40));
  });

  it('does NOT fire on a lagging tick — a failed/incomplete deploy flips nothing', async () => {
    const onDeployVerified = vi.fn();
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      // Lagging target, WITH a repo path — proving it is the lagging status, not
      // a missing repo, that withholds the flip.
      targets: [{ ...laggingTarget('kookr'), repoPath: '/repo/kookr' }],
      now: () => NOW,
      readArtifact: () => null,
      writeArtifact: () => {},
      logger: silentLogger,
      onDeployVerified,
    });

    await detector.maybeRun();
    expect(onDeployVerified).not.toHaveBeenCalled();
  });

  it('does not fire for a converged target without a repo path (additive: opt-in per target)', async () => {
    const onDeployVerified = vi.fn();
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [healthyTarget('kookr')], // no repoPath
      now: () => NOW,
      readArtifact: () => null,
      writeArtifact: () => {},
      logger: silentLogger,
      onDeployVerified,
    });

    await detector.maybeRun();
    expect(onDeployVerified).not.toHaveBeenCalled();
  });

  it('dedups per target: an unchanged converged SHA fires once; a new SHA fires again', async () => {
    let clock = NOW;
    let sha = 'a'.repeat(40);
    const onDeployVerified = vi.fn();
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [{ name: 'kookr', repoPath: '/repo/kookr', resolve: async () => ({ target: 'kookr', deployedSha: sha, mainSha: sha, pendingCommits: [] }) }],
      intervalMs: HOUR_MS,
      now: () => clock,
      readArtifact: () => null,
      writeArtifact: () => {},
      logger: silentLogger,
      onDeployVerified,
    });

    await detector.maybeRun(); // converged @ a… → fire
    clock += HOUR_MS;
    await detector.maybeRun(); // same SHA → deduped, no fire
    expect(onDeployVerified).toHaveBeenCalledTimes(1);

    clock += HOUR_MS;
    sha = 'b'.repeat(40); // a genuinely new deploy
    await detector.maybeRun();
    expect(onDeployVerified).toHaveBeenCalledTimes(2);
  });

  it('a throwing onDeployVerified handler never crashes the tick', async () => {
    const detector = new DeployLagDetector({
      kookrDir: '/tmp/kookr',
      targets: [convergedTarget('kookr', '/repo/kookr')],
      now: () => NOW,
      readArtifact: () => null,
      writeArtifact: () => {},
      logger: silentLogger,
      onDeployVerified: async () => {
        throw new Error('rollup store blew up');
      },
    });

    const artifact = await detector.maybeRun();
    expect(artifact?.status).toBe('ok');
  });
});

describe('buildDeployLagAlertMessage', () => {
  const lagging = buildAlertArtifact(
    [{ name: 'deploy-lag:lucy', ok: false, detail: 'lucy: deployed abc behind; Pending: 2437099 fix: model' }],
    '2026-07-28T12:00:00.000Z',
  );

  it('fired: critical, strips the deploy-lag prefix in the summary, names commits, includes the no-deploy assurance', () => {
    const msg = buildDeployLagAlertMessage(lagging, 'fired', '/tmp/kookr/deploy-lag-alert.json');
    expect(msg.severity).toBe('critical');
    expect(msg.summary).toContain('lucy');
    expect(msg.summary).not.toContain('deploy-lag:'); // prefix stripped
    expect(msg.details).toContain('2437099 fix: model');
    expect(msg.details).toContain('never deploys');
    expect(msg.operationalAlert).toMatchObject({ key: 'deploy:lag', state: 'fired' });
  });

  it('recovered: info severity + recovered state', () => {
    const ok = buildAlertArtifact([{ name: 'deploy-lag:lucy', ok: true, detail: 'ok' }], '2026-07-28T13:00:00.000Z');
    const msg = buildDeployLagAlertMessage(ok, 'recovered', '/tmp/kookr/deploy-lag-alert.json');
    expect(msg.severity).toBe('info');
    expect(msg.operationalAlert).toMatchObject({ key: 'deploy:lag', state: 'recovered' });
  });
});

describe('resolveDeployLagDetectorSettings', () => {
  it('enables by default only on the canonical prod port 4800', () => {
    expect(resolveDeployLagDetectorSettings({}, 4800).enabled).toBe(true);
    expect(resolveDeployLagDetectorSettings({}, 4801).enabled).toBe(false);
  });

  it('the explicit flag overrides the port default', () => {
    expect(resolveDeployLagDetectorSettings({ KOOKR_DEPLOY_LAG_DETECTOR: '0' }, 4800).enabled).toBe(false);
    expect(resolveDeployLagDetectorSettings({ KOOKR_DEPLOY_LAG_DETECTOR: '1' }, 4801).enabled).toBe(true);
  });

  it('a non-positive interval disables the detector; a positive one sets the cadence', () => {
    expect(resolveDeployLagDetectorSettings({ KOOKR_DEPLOY_LAG_INTERVAL_MINUTES: '0' }, 4800).enabled).toBe(false);
    expect(resolveDeployLagDetectorSettings({ KOOKR_DEPLOY_LAG_INTERVAL_MINUTES: '30' }, 4800).intervalMs).toBe(
      30 * 60_000,
    );
  });

  it('a malformed interval warns and keeps the default cadence', () => {
    const warn = vi.fn();
    const { intervalMs, enabled } = resolveDeployLagDetectorSettings(
      { KOOKR_DEPLOY_LAG_INTERVAL_MINUTES: '1h' },
      4800,
      { warn },
    );
    expect(enabled).toBe(true);
    expect(intervalMs).toBe(60 * 60_000);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('createDeployLagDetectorFromEnv', () => {
  it('returns undefined when disabled', () => {
    expect(
      createDeployLagDetectorFromEnv({
        env: { KOOKR_DEPLOY_LAG_DETECTOR: '0' },
        port: 4800,
        kookrDir: '/tmp/kookr',
        kookrRepoPath: '/repo',
        getRunningSha: () => 'a'.repeat(40),
      }),
    ).toBeUndefined();
  });

  it('monitors kookr only when the lucy target is unconfigured', () => {
    const detector = createDeployLagDetectorFromEnv({
      env: { KOOKR_DEPLOY_LAG_DETECTOR: '1' },
      port: 4801,
      kookrDir: '/tmp/kookr',
      kookrRepoPath: '/repo',
      getRunningSha: () => 'a'.repeat(40),
    });
    expect(detector?.monitoredTargets).toEqual(['kookr']);
    expect(detector?.alertArtifactPath).toContain('deploy-lag-alert.json');
  });

  it('adds the lucy target when its status URL and local clone are configured', () => {
    const detector = createDeployLagDetectorFromEnv({
      env: {
        KOOKR_DEPLOY_LAG_DETECTOR: '1',
        KOOKR_DEPLOY_LAG_LUCY_STATUS_URL: 'http://lucy/status',
        KOOKR_DEPLOY_LAG_LUCY_REPO: '/lucy',
      },
      port: 4801,
      kookrDir: '/tmp/kookr',
      kookrRepoPath: '/repo',
      getRunningSha: () => 'a'.repeat(40),
    });
    expect(detector?.monitoredTargets).toEqual(['kookr', 'lucy']);
  });
});

describe('default resolvers use only read-only git verbs (AC4)', () => {
  it('kookr resolver runs fetch/rev-parse/log and never a mutation', async () => {
    const calls: string[][] = [];
    const git: GitReader = async (_cwd, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      return '';
    };
    const resolver = createKookrTargetResolver({
      config: {
        thresholdMs: DEFAULT_DEPLOY_LAG_THRESHOLD_MS,
        fetchBeforeCompare: true,
        kookrRepoPath: '/repo',
        lucyStatusUrl: undefined,
        lucyRepoPath: undefined,
        lucyShaFields: [],
      },
      getRunningSha: () => 'a'.repeat(40),
      git,
    });
    await resolver();
    for (const args of calls) {
      expect(['fetch', 'rev-parse', 'log']).toContain(args[0]);
    }
  });

  it('lucy resolver reads the deployed SHA from the injected status fetcher', async () => {
    const git: GitReader = async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args.includes('2437099^{commit}')) return 'd'.repeat(40);
      if (args[0] === 'rev-parse') return 'e'.repeat(40);
      if (args[0] === 'log') return `${'f'.repeat(7)}\x1f1749990000\x1ffix: y`;
      return '';
    };
    const resolver = createLucyTargetResolver({
      config: {
        thresholdMs: DEFAULT_DEPLOY_LAG_THRESHOLD_MS,
        fetchBeforeCompare: true,
        kookrRepoPath: '/repo',
        lucyStatusUrl: 'http://lucy/status',
        lucyRepoPath: '/lucy',
        lucyShaFields: ['GIT_SHA'],
      },
      git,
      fetchStatus: async () => ({ GIT_SHA: '2437099' }),
    });
    const snap = await resolver();
    expect(snap.deployedSha).toBe('d'.repeat(40));
    expect(snap.pendingCommits).toHaveLength(1);
  });

  it('lucy resolver degrades to unknown when the status surface is unreachable', async () => {
    const git: GitReader = async () => '';
    const resolver = createLucyTargetResolver({
      config: {
        thresholdMs: DEFAULT_DEPLOY_LAG_THRESHOLD_MS,
        fetchBeforeCompare: true,
        kookrRepoPath: '/repo',
        lucyStatusUrl: 'http://lucy/status',
        lucyRepoPath: '/lucy',
        lucyShaFields: ['GIT_SHA'],
      },
      git,
      fetchStatus: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const snap = await resolver();
    expect(snap.deployedSha).toBeNull();
    expect(snap.unavailableReason).toContain('unreachable');
  });
});
