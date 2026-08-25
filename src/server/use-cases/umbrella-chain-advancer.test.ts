import { describe, expect, test, vi } from 'vitest';
import {
  serializePhaseLedgerBlock,
  type PhaseLedger,
} from '../../core/phase-ledger-codec.js';
import {
  UmbrellaChainAdvancer,
  type UmbrellaChainAdvancerLogger,
} from './umbrella-chain-advancer.js';
import type { UmbrellaChainRemote, UmbrellaIssue } from '../../adapters/github-umbrella-chain-client.js';

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

function makeHarness(ledger: PhaseLedger, options: {
  mode?: 'off' | 'observe' | 'spawn';
  reachable?: Set<number>;
  mergedAt?: string | null;
  terminalTasks?: Set<string>;
  issueNumber?: number;
  now?: () => Date;
  launchFails?: boolean;
  finalizeFails?: boolean;
  headSha?: string | null;
} = {}) {
  const events: string[] = [];
  const calls: string[] = [];
  const comments: Array<{ body: string }> = [];
  let launchSawClaim = false;
  const issue: UmbrellaIssue = {
    number: options.issueNumber ?? ledger.issueNumber,
    body: `# Umbrella\n\n${serializePhaseLedgerBlock(ledger)}\n`,
    comments,
  };
  const claims = new Map<string, { key: string; ownerToken: string; claimedAt: string; taskId?: string }>();
  const remote: UmbrellaChainRemote = {
    async listOpenIssues(repo) {
      calls.push(`list:${repo}`);
      return [{ number: issue.number }];
    },
    async getIssue(repo, number) {
      calls.push(`issue:${repo}#${number}`);
      return issue;
    },
    async updateIssueBody(repo, number, body) {
      calls.push(`update:${repo}#${number}`);
      issue.body = body;
    },
    async refreshBase(repoPath, baseBranch) {
      calls.push(`fetch:${repoPath}:${baseBranch}`);
    },
    async isPullRequestReachable(repoPath, baseBranch, prNumber, repo) {
      calls.push(`reach:${repoPath}:${baseBranch}:${repo}#${prNumber}`);
      return options.reachable?.has(prNumber) ?? false;
    },
    async getPullRequestMergedAt(repo, prNumber) {
      calls.push(`merged:${repo}#${prNumber}`);
      return options.mergedAt === undefined ? '2026-08-22T00:00:00.000Z' : options.mergedAt;
    },
    async getPullRequestHeadSha(repo, prNumber) {
      calls.push(`head:${repo}#${prNumber}`);
      return options.headSha ?? 'test-head';
    },
  };
  const logger: UmbrellaChainAdvancerLogger = {
    info: (line) => events.push(line),
    warn: (line) => events.push(`WARN ${line}`),
  };
  const advancer = new UmbrellaChainAdvancer({
    kookrDir: '/tmp/kookr-chain-test',
    repo: 'kookr-ai/kookr',
    repoPath: '/tmp/kookr-repo',
    remote,
    mode: options.mode ?? 'observe',
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
        if (options.finalizeFails) throw new Error('synthetic finalize failure');
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
    ...(options.terminalTasks ? { isTaskTerminal: (taskId: string) => options.terminalTasks!.has(taskId) } : {}),
    ...(options.now ? { now: options.now } : {}),
    isReviewTaskIndependent: () => true,
    launch: async (launchOptions) => {
      launchSawClaim = claims.has(launchOptions.idempotencyKey);
      calls.push(`launch:${launchOptions.idempotencyKey}`);
      if (options.launchFails) throw new Error('synthetic launch failure');
      return { taskId: 'task-next' };
    },
    logger,
  });
  return { advancer, issue, comments, calls, events, claims, get launchSawClaim() { return launchSawClaim; } };
}

describe('UmbrellaChainAdvancer', () => {
  test('fetches the base before scoped PR reachability and blocks on an unmerged predecessor', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'in-flight' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn' });
    await harness.advancer.sweep();
    expect(harness.calls.indexOf('fetch:/tmp/kookr-repo:main')).toBeLessThan(
      harness.calls.findIndex((call) => call.startsWith('reach:')),
    );
    expect(harness.calls).not.toContain('launch:chain:2711:phase:P2');
    expect(harness.issue.body).toContain('"blockedReason": "dependency-unmerged"');
    expect(harness.events.some((event) => event.includes('"decision":"skip"') && event.includes('dependency-unmerged'))).toBe(true);
  });

  test('atomically claims before POST and sends the deterministic idempotency key', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'spawn' });
    await harness.advancer.sweep();
    expect(harness.calls).toContain('launch:chain:2711:phase:P1');
    expect(harness.launchSawClaim).toBe(true);
    expect(harness.claims.get('chain:2711:phase:P1')).toMatchObject({ taskId: 'task-next' });
    expect(harness.issue.body).toContain('"status": "in-flight"');
    expect(harness.issue.body).toContain('"taskId": "task-next"');
  });

  test('does not double-spawn a pre-existing claim', async () => {
    const ledger = makeLedger({ phases: [
      { id: 'P1', dependsOn: [], status: 'in-flight', taskId: 'task-live', ownerTerminal: true },
      { id: 'P2', dependsOn: ['P1'], status: 'pending' },
    ] });
    const harness = makeHarness(ledger, { mode: 'spawn', terminalTasks: new Set() });
    // A pre-existing claim represents the task that is still running.
    harness.claims.set('chain:2711:phase:P1', { key: 'chain:2711:phase:P1', ownerToken: 'owner:chain:2711:phase:P1', claimedAt: '2026-08-23T10:00:00.000Z', taskId: 'task-live' });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.events.some((event) => event.includes('in-flight-claim'))).toBe(true);
  });

  test('does not advance while the current owner is non-terminal', async () => {
    const harness = makeHarness(makeLedger({ phases: [
      { id: 'P1', dependsOn: [], status: 'in-flight', taskId: 'task-live' },
      { id: 'P2', dependsOn: ['P1'], status: 'pending' },
    ] }), { mode: 'spawn', terminalTasks: new Set() });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.events.some((event) => event.includes('owner-active'))).toBe(true);
  });

  test('requires the predecessor owner to be terminal after the grace window', async () => {
    const harness = makeHarness(makeLedger({ phases: [
      {
        id: 'P1',
        dependsOn: [],
        prNumber: 10,
        status: 'merged',
        taskId: 'owner-1',
        mergedAt: '2026-08-22T00:00:00.000Z',
        reviewVerdict: 'pass',
        reviewedAt: '2026-08-22T01:00:00.000Z',
        reviewerTaskId: 'review-1',
        reviewHeadSha: 'test-head',
      },
      { id: 'P2', dependsOn: ['P1'], status: 'pending' },
    ] }), { mode: 'spawn', reachable: new Set([10]), terminalTasks: new Set() });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.events.some((event) => event.includes('predecessor-owner-active'))).toBe(true);
  });

  test('requires an independent post-merge review before advancing', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'merged', taskId: 'owner-1', ownerTerminal: true, mergedAt: '2026-08-22T00:00:00.000Z' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', reachable: new Set([10]) });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.issue.body).toContain('"blockedReason": "review-block"');
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      reviewAudit: 'missing',
    });

    harness.comments.push({
      body: `<!-- kookr-phase-result ${JSON.stringify({
        version: 1,
        chainId: 'chain:kookr-ai/kookr:2711',
        issueNumber: 2711,
        phaseId: 'P1',
        reviewVerdict: 'pass',
        reviewedAt: '2026-08-23T10:00:00.000Z',
        reviewerTaskId: 'review-1',
        reviewHeadSha: 'test-head',
      })} -->`,
    });
    await harness.advancer.sweep();
    expect(harness.calls).toContain('launch:chain:2711:phase:P2');
  });

  test('uses the remote merge time when a valid review arrives before the first sweep', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'in-flight', taskId: 'owner-1', ownerTerminal: true },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), {
      mode: 'spawn',
      reachable: new Set([10]),
      mergedAt: '2026-08-23T09:00:00.000Z',
      now: () => new Date('2026-08-23T10:00:00.000Z'),
    });
    harness.comments.push({
      body: `<!-- kookr-phase-result ${JSON.stringify({
        version: 1,
        chainId: 'chain:kookr-ai/kookr:2711',
        issueNumber: 2711,
        phaseId: 'P1',
        reviewVerdict: 'pass',
        reviewedAt: '2026-08-23T09:30:00.000Z',
        reviewerTaskId: 'review-1',
        reviewHeadSha: 'test-head',
      })} -->`,
    });
    await harness.advancer.sweep();
    expect(harness.issue.body).toContain('"mergedAt": "2026-08-23T09:00:00.000Z"');
    expect(harness.calls).toContain('launch:chain:2711:phase:P2');
  });

  test('does not advance on a review bound to a stale PR head', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'merged', taskId: 'owner-1', ownerTerminal: true, mergedAt: '2026-08-22T00:00:00.000Z', reviewVerdict: 'pass', reviewedAt: '2026-08-23T09:00:00.000Z', reviewerTaskId: 'review-1', reviewAttempts: 1, reviewHeadSha: 'old-head' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', reachable: new Set([10]), headSha: 'new-head' });
    await harness.advancer.sweep();
    expect(harness.calls).toContain('head:kookr-ai/kookr#10');
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.issue.body).toContain('"blockedReason": "review-block"');
  });

  test('holds the chain when the remote cannot provide a merge time', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'in-flight', taskId: 'owner-1', ownerTerminal: true },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', reachable: new Set([10]), mergedAt: null });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.issue.body).toContain('"blockedReason": "dependency-unmerged"');
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('waiting on PR #10'),
    });
  });

  test('holds the chain when the remote returns an invalid merge timestamp', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'in-flight', taskId: 'owner-1', ownerTerminal: true },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', reachable: new Set([10]), mergedAt: '2026-02-30T00:00:00.000Z' });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.advancer.getHealthSnapshot().chains[0]?.reason).toContain('waiting on PR #10');
  });

  test('does not reclaim a stale finalized claim while its task is still active', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'spawn', terminalTasks: new Set() });
    harness.claims.set('chain:2711:phase:P1', {
      key: 'chain:2711:phase:P1',
      ownerToken: 'owner:chain:2711:phase:P1',
      claimedAt: '2026-08-22T00:00:00.000Z',
      taskId: 'task-live',
    });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
  });

  test('rejects a review verdict recorded before the merge point', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        {
          id: 'P1',
          dependsOn: [],
          prNumber: 10,
          status: 'merged',
          taskId: 'owner-1',
          ownerTerminal: true,
          mergedAt: '2026-08-23T10:00:00.000Z',
          reviewVerdict: 'pass',
          reviewHeadSha: 'test-head',
          reviewedAt: '2026-08-23T09:59:00.000Z',
          reviewerTaskId: 'review-1',
        },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', reachable: new Set([10]), mergedAt: '2026-08-23T10:00:00.000Z' });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      reviewAudit: 'missing',
    });
  });

  test('releases the claim when launch fails', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'spawn', launchFails: true });
    await harness.advancer.sweep();
    expect(harness.claims.size).toBe(0);
    expect(harness.issue.body).not.toContain('"taskId": "task-next"');
    expect(harness.advancer.getHealthSnapshot().chains[0]?.reason).toContain('spawn-failed');
  });

  test('retains the owner claim when finalization fails after launch', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'spawn', finalizeFails: true });
    await harness.advancer.sweep();
    expect(harness.calls).toContain('launch:chain:2711:phase:P1');
    expect(harness.claims.get('chain:2711:phase:P1')).toMatchObject({ ownerToken: 'owner:chain:2711:phase:P1' });
    expect(harness.issue.body).toContain('"taskId": "task-next"');
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      inFlight: true,
      reason: expect.stringContaining('claim-finalize-failed'),
    });
  });

  test('observe mode evaluates and records health without spawning', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'observe' });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'eligible',
      nextPhase: 'P1',
      reason: 'observe-only',
    });
  });

  test('observe mode never writes reconciled ledger state', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        {
          id: 'P1',
          dependsOn: [],
          prNumber: 10,
          status: 'in-flight',
          taskId: 'owner-1',
          ownerTerminal: true,
          mergedAt: '2026-08-22T00:00:00.000Z',
          reviewVerdict: 'pass',
          reviewHeadSha: 'test-head',
          reviewedAt: '2026-08-22T01:00:00.000Z',
          reviewerTaskId: 'review-1',
        },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'observe', reachable: new Set([10]) });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('update:'))).toHaveLength(0);
  });

  test('global self-advancing kill switch prevents spawning', async () => {
    vi.stubEnv('KOOKR_SELF_ADVANCING_DISABLED', '1');
    try {
      const harness = makeHarness(makeLedger(), { mode: 'spawn' });
      await harness.advancer.sweep();
      expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
      expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
        status: 'eligible',
        reason: 'self-advancing-disabled',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('off mode does not start a sweep', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'off' });
    harness.advancer.start();
    await Promise.resolve();
    expect(harness.calls).toHaveLength(0);
    expect(harness.advancer.getHealthSnapshot().running).toBe(false);
    await harness.advancer.stop();
  });

  test('rejects a ledger whose issue number is outside the scanned issue', async () => {
    const harness = makeHarness(makeLedger(), { issueNumber: 999, mode: 'spawn' });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('reach:'))).toHaveLength(0);
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({ status: 'malformed' });
  });

  test('concurrent sweeps serialize into one remote scan', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'observe' });
    const first = harness.advancer.sweep();
    const second = harness.advancer.sweep();
    await Promise.all([first, second]);
    expect(harness.calls.filter((call) => call.startsWith('list:'))).toHaveLength(1);
    expect(harness.advancer.getHealthSnapshot().tickCount).toBe(1);
  });
});
