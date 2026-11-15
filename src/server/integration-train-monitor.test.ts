import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WriteOperatorSignalInput } from '../observability/signal-delivery/operator-signal.js';
import {
  createIntegrationTrainMonitorFromEnv,
  IntegrationTrainMonitor,
  TRAIN_STALL_SIGNAL_KEY,
  type RemoteRefs,
} from './integration-train-monitor.js';
import type { IntegrationTrainStatus } from './integration-train-runtime.js';

const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(initial: { refs: RemoteRefs | null; status: Partial<IntegrationTrainStatus>; branch?: string | null }) {
  const dir = mkdtempSync(join(tmpdir(), 'train-monitor-'));
  dirs.push(dir);
  const world = {
    nowMs: Date.parse('2026-11-15T10:00:00Z'),
    refs: initial.refs,
    branch: initial.branch === undefined ? 'staging' : initial.branch,
    status: { stateDir: dir, running: true, pid: 1, halted: null, lastCycle: null, restartPending: null, ...initial.status } as IntegrationTrainStatus,
  };
  const signals: WriteOperatorSignalInput[] = [];
  const make = () => new IntegrationTrainMonitor({
    kookrDir: dir,
    repoPath: dir,
    thresholdMs: 30 * MIN,
    readConfiguredBranch: async () => world.branch,
    readRemoteRefs: async () => world.refs,
    readStatus: () => world.status,
    writeSignal: async (input) => { signals.push(input); },
    now: () => world.nowMs,
    logger: { log: () => {}, warn: () => {} },
  });
  return { world, signals, make, monitor: make() };
}

const AHEAD: RemoteRefs = { main: 'aaa', integration: 'bbb' };

describe('IntegrationTrainMonitor', () => {
  it('alerts once when the integration branch has differed from main past the threshold and the train is not running', async () => {
    const h = harness({ refs: AHEAD, status: { running: false, pid: null } });
    await h.monitor.maybeRun();
    h.world.nowMs += 29 * MIN;
    await h.monitor.maybeRun();
    expect(h.signals).toEqual([]);

    h.world.nowMs += 2 * MIN;
    await h.monitor.maybeRun();
    h.world.nowMs += 5 * MIN;
    await h.monitor.maybeRun();
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]).toMatchObject({ key: TRAIN_STALL_SIGNAL_KEY, kind: 'alert', source: 'integration-train-monitor' });
    expect(h.signals[0].detail).toContain('staging has differed from main for 31 min');
    expect(h.signals[0].detail).toContain('not running');
    expect(h.monitor.getHealthSnapshot()).toMatchObject({ integrationBranch: 'staging', running: false, alerting: true });
  });

  it('alerts while the train runs but is halted, naming the reason', async () => {
    const h = harness({ refs: AHEAD, status: { halted: { reason: 'base-red', at: 'x' } } });
    await h.monitor.maybeRun();
    h.world.nowMs += 31 * MIN;
    await h.monitor.maybeRun();
    expect(h.signals.map((s) => s.kind)).toEqual(['alert']);
    expect(h.signals[0].detail).toContain('halted (base-red)');
  });

  it('never alerts for a running train, however long a verify takes', async () => {
    const h = harness({ refs: AHEAD, status: {} });
    for (let i = 0; i < 20; i++) {
      await h.monitor.maybeRun();
      h.world.nowMs += 5 * MIN;
    }
    expect(h.signals).toEqual([]);
  });

  it('restarts the clock whenever main moves: a train that promotes is not stalled', async () => {
    const h = harness({ refs: AHEAD, status: { running: false, pid: null } });
    await h.monitor.maybeRun();
    h.world.nowMs += 25 * MIN;
    h.world.refs = { main: 'bbb', integration: 'ccc' }; // promoted, and new work merged
    await h.monitor.maybeRun();
    h.world.nowMs += 25 * MIN;
    await h.monitor.maybeRun();
    expect(h.signals).toEqual([]);
    h.world.nowMs += 6 * MIN;
    await h.monitor.maybeRun();
    expect(h.signals.map((s) => s.kind)).toEqual(['alert']);
  });

  it('clears the alert once main catches up, and again only after a new stall', async () => {
    const h = harness({ refs: AHEAD, status: { running: false, pid: null } });
    await h.monitor.maybeRun();
    h.world.nowMs += 31 * MIN;
    await h.monitor.maybeRun();
    h.world.refs = { main: 'bbb', integration: 'bbb' };
    h.world.nowMs += 5 * MIN;
    await h.monitor.maybeRun();
    await h.monitor.maybeRun();
    expect(h.signals.map((s) => [s.kind, s.key])).toEqual([
      ['alert', TRAIN_STALL_SIGNAL_KEY], ['clear', TRAIN_STALL_SIGNAL_KEY],
    ]);
    expect(h.signals[1].detail).toContain('main has caught up with staging');
    expect(h.monitor.getHealthSnapshot()).toMatchObject({ pendingSince: null, alerting: false });
  });

  it('clears when the train is started again even before it has caught up', async () => {
    const h = harness({ refs: AHEAD, status: { running: false, pid: null } });
    await h.monitor.maybeRun();
    h.world.nowMs += 31 * MIN;
    await h.monitor.maybeRun();
    h.world.status = { ...h.world.status, running: true, pid: 2 };
    await h.monitor.maybeRun();
    expect(h.signals.map((s) => s.kind)).toEqual(['alert', 'clear']);
  });

  it('shows a restart that waits for the cycle to end in the health snapshot (issue #3841)', async () => {
    const h = harness({ refs: AHEAD, status: { restartPending: { requestedAt: '2026-11-15T21:13:22Z' } } });
    await h.monitor.maybeRun();
    expect(h.monitor.getHealthSnapshot()).toMatchObject({ running: true, restartPending: { requestedAt: '2026-11-15T21:13:22Z' } });
  });

  it('keeps the clock and the alert across a server restart', async () => {
    const h = harness({ refs: AHEAD, status: { running: false, pid: null } });
    await h.monitor.maybeRun();
    h.world.nowMs += 20 * MIN;
    // a new server process: the stall started 20 minutes ago, not now
    const second = h.make();
    h.world.nowMs += 11 * MIN;
    await second.maybeRun();
    expect(h.signals.map((s) => s.kind)).toEqual(['alert']);
    // and the next restart does not alert again
    const third = h.make();
    await third.maybeRun();
    expect(h.signals.map((s) => s.kind)).toEqual(['alert']);
  });

  it('changes nothing when the remote refs cannot be read', async () => {
    const h = harness({ refs: AHEAD, status: { running: false, pid: null } });
    await h.monitor.maybeRun();
    h.world.nowMs += 31 * MIN;
    await h.monitor.maybeRun();
    h.world.refs = null;
    await h.monitor.maybeRun();
    expect(h.signals.map((s) => s.kind)).toEqual(['alert']);
    expect(h.monitor.getHealthSnapshot()).toMatchObject({ alerting: true, lastError: 'could not read main and staging from origin' });
  });

  it('has no health block and closes its alert when no integration branch is configured', async () => {
    const h = harness({ refs: AHEAD, status: { running: false, pid: null } });
    await h.monitor.maybeRun();
    h.world.nowMs += 31 * MIN;
    await h.monitor.maybeRun();
    h.world.branch = null;
    await h.monitor.maybeRun();
    expect(h.signals.map((s) => s.kind)).toEqual(['alert', 'clear']);
    expect(h.monitor.getHealthSnapshot()).toBeNull();
  });

  it('never throws out of maybeRun', async () => {
    const h = harness({ refs: AHEAD, status: {} });
    const broken = new IntegrationTrainMonitor({
      kookrDir: h.world.status.stateDir,
      repoPath: h.world.status.stateDir,
      readConfiguredBranch: async () => { throw new Error('boom'); },
      logger: { log: () => {}, warn: () => {} },
    });
    await expect(broken.maybeRun()).resolves.toBeUndefined();
  });
});

describe('createIntegrationTrainMonitorFromEnv', () => {
  it('is on by default only on the production port, and can be forced either way', () => {
    const base = { kookrDir: '/nonexistent', repoPath: '/nonexistent' };
    expect(createIntegrationTrainMonitorFromEnv({ ...base, env: {}, port: 4800 })).toBeInstanceOf(IntegrationTrainMonitor);
    expect(createIntegrationTrainMonitorFromEnv({ ...base, env: {}, port: 4801 })).toBeUndefined();
    expect(createIntegrationTrainMonitorFromEnv({ ...base, env: { KOOKR_INTEGRATION_TRAIN_MONITOR: '0' }, port: 4800 })).toBeUndefined();
    expect(createIntegrationTrainMonitorFromEnv({ ...base, env: { KOOKR_INTEGRATION_TRAIN_MONITOR: '1' }, port: 4801 })).toBeInstanceOf(IntegrationTrainMonitor);
  });
});

describe('readRemoteRefsFromRepo', () => {
  it('reads main and the integration branch from the remote, not from tracking refs', async () => {
    const { execFileSync } = await import('node:child_process');
    const { gitExecEnv } = await import('../core/git-helpers.js');
    const { readRemoteRefsFromRepo, readConfiguredBranchFromRepo } = await import('./integration-train-monitor.js');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'train-monitor-git-'));
    dirs.push(root);
    const env = {
      ...gitExecEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    mkdirSync(origin);
    git(origin, 'init', '--bare', '-q', '--initial-branch=main');
    git(root, 'clone', '-q', origin, work);
    git(work, 'checkout', '-q', '-b', 'main');
    mkdirSync(join(work, '.kookr'));
    writeFileSync(join(work, '.kookr/delivery-gate.json'), '{"integrationBranch":"staging"}');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'base');
    git(work, 'push', '-q', 'origin', 'main', 'main:refs/heads/staging');
    git(work, 'fetch', '-q', 'origin');
    const base = git(work, 'rev-parse', 'HEAD');
    // staging moves on the remote; the checkout's tracking refs do not know yet
    git(work, 'commit', '-q', '--allow-empty', '-m', 'more');
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/staging');
    git(work, 'update-ref', 'refs/remotes/origin/staging', base);
    const head = git(work, 'rev-parse', 'HEAD');

    expect(await readConfiguredBranchFromRepo(work)).toBe('staging');
    expect(await readRemoteRefsFromRepo(work, 'staging')).toEqual({ main: base, integration: head });
    expect(await readRemoteRefsFromRepo(work, 'nope')).toBeNull();
  });
});
