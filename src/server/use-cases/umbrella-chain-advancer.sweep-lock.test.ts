import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  serializePhaseLedgerBlock,
  type PhaseLedger,
} from '../../core/phase-ledger-codec.js';
import {
  UmbrellaChainAdvancer,
  type UmbrellaChainAdvancerLogger,
} from './umbrella-chain-advancer.js';
import type { UmbrellaChainRemote, UmbrellaIssue } from '../../adapters/github-umbrella-chain-client.js';

/**
 * Cross-process single-flight proof for the umbrella-chain advancer sweep
 * (umbrella #2711 Phase 2, leaf #2788, acceptance criterion 2).
 *
 * The advancer serializes overlapping sweeps two ways: an in-process promise
 * guard (covered in `umbrella-chain-advancer.test.ts`) and a mkdir-backed
 * cross-process lock at `<kookrDir>/umbrella-chain-advancer.sweep.lock`. Only
 * the cross-process layer defends against a *second process* (a restarted
 * daemon, a stray operator tick) sweeping the same repo concurrently. These
 * tests drive the real {@link withCrossProcessLock} — not a mock — by planting
 * a lock directory owned by a live foreign holder and asserting that the
 * overlapping tick skips cleanly, then that releasing the lock lets the next
 * tick advance exactly one phase. Together they prove an overlapping tick can
 * neither double-advance nor skip a phase.
 */

/** The lock path the advancer derives from its `kookrDir` (kept in lockstep with the impl). */
function sweepLockPath(kookrDir: string): string {
  return join(kookrDir, 'umbrella-chain-advancer.sweep.lock');
}

/**
 * Plant a lock directory as if another *live* process owns it. `process.ppid`
 * is a real pid that is alive for the duration of the test and is never this
 * worker's own pid, so the advancer's default liveness probe reports it held.
 */
function holdSweepLockAsForeignProcess(kookrDir: string): void {
  const lockPath = sweepLockPath(kookrDir);
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, 'holder.json'),
    JSON.stringify({ pid: process.ppid, startedAt: '2026-08-23T00:00:00.000Z' }),
    { flag: 'wx' },
  );
}

function releaseSweepLock(kookrDir: string): void {
  rmSync(sweepLockPath(kookrDir), { recursive: true, force: true });
}

function makeLedger(overrides: Partial<PhaseLedger> = {}): PhaseLedger {
  return {
    version: 1,
    chainId: 'chain:kookr-ai/kookr:2711',
    repo: 'kookr-ai/kookr',
    issueNumber: 2711,
    phases: [
      { id: 'P1', dependsOn: [], status: 'pending' },
      { id: 'P2', dependsOn: ['P1'], status: 'pending' },
    ],
    ...overrides,
  };
}

function makeHarness(kookrDir: string, ledger: PhaseLedger) {
  const events: string[] = [];
  const calls: string[] = [];
  const issue: UmbrellaIssue = {
    number: ledger.issueNumber,
    body: `# Umbrella\n\n${serializePhaseLedgerBlock(ledger)}\n`,
    comments: [],
  };
  const claims = new Map<string, { key: string; ownerToken: string; claimedAt: string; taskId?: string }>();
  const remote: UmbrellaChainRemote = {
    async listOpenIssues(repo) {
      calls.push(`list:${repo}`);
      return [{ number: issue.number }];
    },
    async getIssue() {
      calls.push('issue');
      return issue;
    },
    async updateIssueBody(_repo, _number, body) {
      calls.push('update');
      issue.body = body;
    },
    async refreshBase() {
      calls.push('fetch');
    },
    async isPullRequestReachable(_repoPath, _baseBranch, prNumber) {
      calls.push(`reach:#${prNumber}`);
      return false;
    },
    async getPullRequestMergedAt() {
      return '2026-08-22T00:00:00.000Z';
    },
    async getPullRequestHeadSha() {
      return 'test-head';
    },
  };
  const logger: UmbrellaChainAdvancerLogger = {
    info: (line) => events.push(line),
    warn: (line) => events.push(`WARN ${line}`),
  };
  const advancer = new UmbrellaChainAdvancer({
    kookrDir,
    repo: 'kookr-ai/kookr',
    repoPath: '/tmp/kookr-repo',
    remote,
    mode: 'spawn',
    claimStore: {
      async claim(key) {
        const existing = claims.get(key);
        if (existing) return { kind: 'busy', claim: existing };
        const claim = { key, ownerToken: `owner:${key}`, claimedAt: '2026-08-23T10:00:00.000Z' };
        claims.set(key, claim);
        return { kind: 'claimed', claim };
      },
      async finalize(key, taskId, ownerToken) {
        const claim = claims.get(key);
        if (!claim || claim.ownerToken !== ownerToken) throw new Error('ownership lost');
        claim.taskId = taskId;
      },
      async release(key, ownerToken) {
        const claim = claims.get(key);
        if (!claim || claim.ownerToken !== ownerToken) throw new Error('ownership lost');
        claims.delete(key);
      },
      async get(key) {
        return claims.get(key);
      },
    },
    isReviewTaskIndependent: () => true,
    launch: async (options) => {
      calls.push(`launch:${options.idempotencyKey}`);
      return { taskId: 'task-next' };
    },
    logger,
  });
  return { advancer, issue, calls, events, claims };
}

describe('UmbrellaChainAdvancer cross-process sweep lock', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempKookrDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-sweep-lock-'));
    tempDirs.push(dir);
    return dir;
  }

  test('an overlapping tick from another process is skipped, never double-advanced', () => {
    const kookrDir = tempKookrDir();
    // A concurrent sweep in another process holds the lock. Our tick must not
    // scan, spawn, or touch the ledger while that sweep is in flight.
    holdSweepLockAsForeignProcess(kookrDir);
    const harness = makeHarness(kookrDir, makeLedger());
    const bodyBefore = harness.issue.body;

    return harness.advancer.sweep().then(() => {
      expect(harness.calls).toHaveLength(0);
      expect(harness.claims.size).toBe(0);
      expect(harness.issue.body).toBe(bodyBefore);
      // The busy tick reports single-flight rather than counting as a real tick.
      const health = harness.advancer.getHealthSnapshot();
      expect(health.tickCount).toBe(0);
      expect(health.lastTickError).toBeNull();
      expect(health.chains).toHaveLength(0);
      expect(harness.events.some((event) => event.includes('"reason":"sweep-in-flight"') && event.includes('"inFlight":true'))).toBe(true);
    });
  });

  test('the lock only defers: once released, the deferred phase advances exactly once', async () => {
    const kookrDir = tempKookrDir();
    holdSweepLockAsForeignProcess(kookrDir);
    const harness = makeHarness(kookrDir, makeLedger());

    // While the foreign sweep holds the lock the phase is deferred, not skipped.
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);

    // The foreign sweep finishes and releases the lock; the deferred phase is
    // still eligible and now advances — proving the lock delays rather than
    // drops the advance.
    releaseSweepLock(kookrDir);
    await harness.advancer.sweep();
    expect(harness.calls).toContain('launch:chain:2711:phase:P1');
    expect(harness.advancer.getHealthSnapshot().tickCount).toBe(1);

    // A later overlapping-but-unlocked tick finds the durable claim and running
    // owner, so no phase is ever advanced twice.
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(1);
    expect(harness.claims.get('chain:2711:phase:P1')).toMatchObject({ taskId: 'task-next' });
  });
});
