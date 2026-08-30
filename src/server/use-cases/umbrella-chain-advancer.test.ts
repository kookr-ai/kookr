import { describe, expect, test, vi } from 'vitest';
import {
  serializePhaseLedgerBlock,
  type PhaseLedger,
} from '../../core/phase-ledger-codec.js';
import {
  buildUmbrellaChainProjectInventory,
  UmbrellaChainAdvancer,
  phaseClaimKey,
  legacyPhaseClaimKey,
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
  /**
   * Body returned by `getIssue` from its second call onward, simulating a
   * concurrent writer that mutated the umbrella body between the sweep's read
   * and the refetch the sweep does immediately before writing (so that only one
   * writer's copy is ever applied).
   */
  concurrentRefetchBody?: string;
  /** When set, `getIssue` returns null from its second call onward (persist-time refetch fails). */
  refetchReturnsNull?: boolean;
  repo?: string;
  projects?: readonly {
    projectId: string;
    repo: string;
    repoPath: string;
    baseBranch?: string;
  }[];
  legacyClaimRepo?: string | null;
  reclaimableClaims?: Set<string>;
} = {}) {
  const events: string[] = [];
  const calls: string[] = [];
  const comments: Array<{ body: string }> = [];
  let launchSawClaim = false;
  let getIssueCalls = 0;
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
      getIssueCalls += 1;
      if (getIssueCalls > 1 && options.refetchReturnsNull) {
        return null;
      }
      if (getIssueCalls > 1 && options.concurrentRefetchBody !== undefined) {
        return { number: issue.number, body: options.concurrentRefetchBody, comments };
      }
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
    repo: options.repo ?? 'kookr-ai/kookr',
    repoPath: '/tmp/kookr-repo',
    ...(options.projects ? { projects: async () => options.projects! } : {}),
    ...(options.legacyClaimRepo !== undefined ? { legacyClaimRepo: options.legacyClaimRepo } : {}),
    remote,
    mode: options.mode ?? 'observe',
    claimStore: {
      async claim(key) {
        const existing = claims.get(key);
        if (existing && !options.reclaimableClaims?.has(key)) {
          return { kind: 'busy', claim: existing };
        }
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
  test('TS-CHAIN-001: inventory skips projects without a canonical checkout or remote default branch', async () => {
    const warnings: string[] = [];
    const inventory = await buildUmbrellaChainProjectInventory([
      'github.com/example/good',
      'github.com/example/no-checkout',
      'github.com/example/no-remote-default',
      'local/not-github',
    ], {
      async resolveRepoPath(projectId) {
        if (projectId.endsWith('/no-checkout')) throw new Error('checkout unresolved');
        return `/repos/${projectId.split('/').at(-1)}`;
      },
      async resolveDefaultRef(repoPath) {
        return repoPath.endsWith('/no-remote-default') ? null : 'origin/main';
      },
      warn: (message) => warnings.push(message),
    });

    expect(inventory).toEqual([{
      projectId: 'github.com/example/good',
      repo: 'example/good',
      repoPath: '/repos/good',
      baseBranch: 'main',
    }]);
    expect(warnings).toEqual([
      '[umbrella-chain-advancer] skipping github.com/example/no-checkout: checkout unresolved',
      '[umbrella-chain-advancer] skipping github.com/example/no-remote-default: remote default branch is unresolved',
    ]);
  });

  test('TS-CHAIN-001: scans configured repositories independently and preserves project-qualified identity', async () => {
    const contexts = [
      {
        projectId: 'github.com/kookr-ai/kookr',
        repo: 'kookr-ai/kookr',
        repoPath: '/repos/kookr',
        baseBranch: 'main',
      },
      {
        projectId: 'github.com/example/external',
        repo: 'example/external',
        repoPath: '/repos/external',
        baseBranch: 'master',
      },
    ];
    const ledgers = new Map(contexts.map((context) => [context.repo, makeLedger({
      chainId: `chain:${context.repo}:2711`,
      repo: context.repo,
    })]));
    const calls: string[] = [];
    const launches: Array<{
      projectId?: string;
      cwd: string;
      idempotencyKey: string;
      claimIssue: { number: number; repo: string };
    }> = [];
    const remote: UmbrellaChainRemote = {
      async listOpenIssues(repo) {
        calls.push(`list:${repo}`);
        return [{ number: 2711 }];
      },
      async getIssue(repo, number) {
        const ledger = ledgers.get(repo);
        if (!ledger) return null;
        return {
          number,
          body: `# Umbrella\n\n${serializePhaseLedgerBlock(ledger)}\n`,
          comments: [],
        };
      },
      async updateIssueBody() {},
      async refreshBase(repoPath, baseBranch) {
        calls.push(`fetch:${repoPath}:${baseBranch}`);
      },
      async isPullRequestReachable() {
        return false;
      },
      async getPullRequestMergedAt() {
        return null;
      },
      async getPullRequestHeadSha() {
        return null;
      },
    };
    const advancer = new UmbrellaChainAdvancer({
      kookrDir: '/tmp/kookr-chain-project-test',
      repo: contexts[0]!.repo,
      repoPath: contexts[0]!.repoPath,
      projects: async () => contexts,
      remote,
      mode: 'spawn',
      claimStore: {
        async claim(key) {
          return {
            kind: 'claimed',
            claim: { key, ownerToken: `owner:${key}`, claimedAt: '2026-08-23T10:00:00.000Z' },
          };
        },
        async finalize() {},
        async release() {},
        async get() { return undefined; },
      },
      launch: async (options) => {
        launches.push(options);
        return { taskId: `task-${launches.length}` };
      },
      isReviewTaskIndependent: () => true,
    });

    await advancer.sweep();

    expect(calls).toEqual(expect.arrayContaining([
      'list:kookr-ai/kookr',
      'list:example/external',
      'fetch:/repos/kookr:main',
      'fetch:/repos/external:master',
    ]));
    expect(launches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId: 'github.com/kookr-ai/kookr',
        cwd: '/repos/kookr',
        idempotencyKey: 'chain:kookr-ai/kookr:2711:phase:P1',
        claimIssue: { number: 2711, repo: 'kookr-ai/kookr' },
      }),
      expect.objectContaining({
        projectId: 'github.com/example/external',
        cwd: '/repos/external',
        idempotencyKey: 'chain:example/external:2711:phase:P1',
        claimIssue: { number: 2711, repo: 'example/external' },
      }),
    ]));
    expect(advancer.getHealthSnapshot().chains).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueNumber: 2711, repo: 'kookr-ai/kookr' }),
      expect.objectContaining({ issueNumber: 2711, repo: 'example/external' }),
    ]));
    expect(advancer.getHealthSnapshot().chains).toHaveLength(2);
  });

  test('TS-CHAIN-001: continues with later repositories when one project scan fails', async () => {
    const calls: string[] = [];
    const ledger = makeLedger({
      chainId: 'chain:example/good:2711',
      repo: 'example/good',
    });
    const remote: UmbrellaChainRemote = {
      async listOpenIssues(repo) {
        calls.push(`list:${repo}`);
        if (repo === 'example/broken') throw new Error('repository unavailable');
        return [{ number: ledger.issueNumber }];
      },
      async getIssue(_repo, number) {
        return { number, body: serializePhaseLedgerBlock(ledger), comments: [] };
      },
      async updateIssueBody() {},
      async refreshBase(repoPath) { calls.push(`fetch:${repoPath}`); },
      async isPullRequestReachable() { return false; },
      async getPullRequestMergedAt() { return null; },
      async getPullRequestHeadSha() { return null; },
    };
    const warnings: string[] = [];
    const advancer = new UmbrellaChainAdvancer({
      kookrDir: '/tmp/kookr-chain-project-failure-test',
      repo: 'kookr-ai/kookr',
      repoPath: '/repos/kookr',
      projects: async () => [
        { projectId: 'github.com/example/broken', repo: 'example/broken', repoPath: '/repos/broken' },
        { projectId: 'github.com/example/good', repo: 'example/good', repoPath: '/repos/good' },
      ],
      remote,
      mode: 'observe',
      logger: { warn: (message) => warnings.push(message) },
    });

    await advancer.sweep();

    expect(calls).toEqual(['list:example/broken', 'list:example/good', 'fetch:/repos/good']);
    expect(warnings).toContain(
      '[umbrella-chain-advancer] skipping example/broken: project-scan-error:repository unavailable',
    );
    expect(advancer.getHealthSnapshot().chains).toEqual([
      expect.objectContaining({ repo: 'example/good', issueNumber: 2711 }),
    ]);
  });

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
    expect(harness.calls).not.toContain('launch:chain:kookr-ai/kookr:2711:phase:P2');
    expect(harness.issue.body).toContain('"blockedReason": "dependency-unmerged"');
    expect(harness.events.some((event) => event.includes('"decision":"skip"') && event.includes('dependency-unmerged'))).toBe(true);
  });

  test('atomically claims before POST and sends the deterministic idempotency key', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'spawn' });
    await harness.advancer.sweep();
    expect(harness.calls).toContain('launch:chain:kookr-ai/kookr:2711:phase:P1');
    expect(harness.launchSawClaim).toBe(true);
    expect(harness.claims.get('chain:kookr-ai/kookr:2711:phase:P1')).toMatchObject({ taskId: 'task-next' });
    expect(harness.issue.body).toContain('"status": "in-flight"');
    expect(harness.issue.body).toContain('"taskId": "task-next"');
  });

  test('repository-qualifies phase keys so equal issue numbers cannot collide', async () => {
    const first = makeHarness(makeLedger(), { mode: 'spawn' });
    const secondRepo = 'Example/Other';
    const second = makeHarness(makeLedger({
      chainId: `chain:${secondRepo}:2711`,
      repo: secondRepo,
    }), { mode: 'spawn', repo: secondRepo });

    await first.advancer.sweep();
    await second.advancer.sweep();

    expect(first.calls).toContain('launch:chain:kookr-ai/kookr:2711:phase:P1');
    expect(second.calls).toContain('launch:chain:example/other:2711:phase:P1');
  });

  test('fails closed through a finalized legacy phase claim whose terminal owner recorded no PR', async () => {
    const legacyKey = 'chain:2711:phase:P1';
    const harness = makeHarness(makeLedger(), {
      mode: 'spawn',
      terminalTasks: new Set(['legacy-task']),
    });
    harness.claims.set(legacyKey, {
      key: legacyKey,
      ownerToken: 'legacy-owner',
      claimedAt: '2026-08-23T10:00:00.000Z',
      taskId: 'legacy-task',
    });

    await harness.advancer.sweep();

    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.claims.get(legacyKey)).toMatchObject({ taskId: 'legacy-task' });
    expect(harness.claims.has('chain:kookr-ai/kookr:2711:phase:P1')).toBe(false);
    expect(harness.issue.body).toContain('"taskId": "legacy-task"');
    expect(harness.issue.body).toContain('"ownerTerminal": true');
  });

  test('external projects never consult an unqualified legacy phase claim', async () => {
    const externalRepo = 'example/external';
    const legacyKey = 'chain:2711:phase:P1';
    const harness = makeHarness(makeLedger({
      chainId: `chain:${externalRepo}:2711`,
      repo: externalRepo,
    }), {
      mode: 'spawn',
      terminalTasks: new Set(),
      projects: [{
        projectId: `github.com/${externalRepo}`,
        repo: externalRepo,
        repoPath: '/repos/external',
        baseBranch: 'main',
      }],
    });
    harness.claims.set(legacyKey, {
      key: legacyKey,
      ownerToken: 'legacy-owner',
      claimedAt: '2026-08-23T10:00:00.000Z',
      taskId: 'active-legacy-task',
    });

    await harness.advancer.sweep();

    expect(harness.calls).toContain('launch:chain:example/external:2711:phase:P1');
    expect(harness.claims.get(legacyKey)).toMatchObject({ taskId: 'active-legacy-task' });
  });

  test('fails closed when current and legacy phase claims both exist', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'spawn' });
    for (const key of ['chain:2711:phase:P1', 'chain:kookr-ai/kookr:2711:phase:P1']) {
      harness.claims.set(key, {
        key,
        ownerToken: `owner:${key}`,
        claimedAt: '2026-08-23T10:00:00.000Z',
      });
    }

    await harness.advancer.sweep();

    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.events.some((event) => event.includes('claim-namespace-conflict'))).toBe(true);
    expect(harness.issue.body).toContain('"blockedReason": "stuck-claim"');
    expect(harness.issue.body).toContain('"blockedSince"');
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      reason: 'claim-namespace-conflict',
    });
  });

  test('does not double-spawn a pre-existing claim', async () => {
    const ledger = makeLedger({ phases: [
      { id: 'P1', dependsOn: [], status: 'in-flight', taskId: 'task-live', ownerTerminal: true },
      { id: 'P2', dependsOn: ['P1'], status: 'pending' },
    ] });
    const harness = makeHarness(ledger, { mode: 'spawn', terminalTasks: new Set() });
    // A pre-existing claim represents the task that is still running.
    harness.claims.set('chain:kookr-ai/kookr:2711:phase:P1', { key: 'chain:kookr-ai/kookr:2711:phase:P1', ownerToken: 'owner:chain:kookr-ai/kookr:2711:phase:P1', claimedAt: '2026-08-23T10:00:00.000Z', taskId: 'task-live' });
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

  test('TS-CHAIN-003: fails closed when a terminal phase owner recorded no PR', async () => {
    const harness = makeHarness(makeLedger({ phases: [
      { id: 'P1', dependsOn: [], status: 'in-flight', taskId: 'task-terminal' },
      { id: 'P2', dependsOn: ['P1'], status: 'pending' },
    ] }), { mode: 'spawn', terminalTasks: new Set(['task-terminal']) });

    await harness.advancer.sweep();

    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.issue.body).toContain('"ownerTerminal": true');
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      nextPhase: 'P1',
      reason: expect.stringContaining('terminal-owner-no-pr:P1'),
    });
  });

  test('TS-CHAIN-003: fails closed when terminal ownership has no task id or PR', async () => {
    const harness = makeHarness(makeLedger({ phases: [
      { id: 'P1', dependsOn: [], status: 'in-flight', ownerTerminal: true },
      { id: 'P2', dependsOn: ['P1'], status: 'pending' },
    ] }), { mode: 'spawn' });

    await harness.advancer.sweep();

    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      nextPhase: 'P1',
      reason: expect.stringContaining('terminal-owner-no-pr:P1'),
    });
  });

  test('TS-CHAIN-003: repairs terminal ownership from a finalized claim when the prior ledger write was lost', async () => {
    const harness = makeHarness(makeLedger(), {
      mode: 'spawn',
      terminalTasks: new Set(['task-from-lost-write']),
    });
    const key = 'chain:kookr-ai/kookr:2711:phase:P1';
    harness.claims.set(key, {
      key,
      ownerToken: 'prior-owner',
      claimedAt: '2026-08-23T10:00:00.000Z',
      taskId: 'task-from-lost-write',
    });

    await harness.advancer.sweep();

    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.issue.body).toContain('"taskId": "task-from-lost-write"');
    expect(harness.issue.body).toContain('"ownerTerminal": true');
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('terminal-owner-no-pr:P1'),
    });
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
    expect(harness.calls).toContain('launch:chain:kookr-ai/kookr:2711:phase:P2');
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
    expect(harness.calls).toContain('launch:chain:kookr-ai/kookr:2711:phase:P2');
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

  test('launches a correction task for an exact-head BLOCK while review budget remains', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'merged', taskId: 'owner-1', ownerTerminal: true, mergedAt: '2026-08-22T00:00:00.000Z', reviewVerdict: 'block', reviewedAt: '2026-08-23T09:00:00.000Z', reviewerTaskId: 'review-1', reviewAttempts: 1, reviewHeadSha: 'test-head' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', reachable: new Set([10]) });
    await harness.advancer.sweep();
    expect(harness.calls).toContain('launch:chain:kookr-ai/kookr:2711:phase:P1:review:2');
    expect(harness.issue.body).toContain('"status": "in-flight"');
    expect(harness.issue.body).toContain('"taskId": "task-next"');
    expect(harness.issue.body).not.toContain('"reviewVerdict": "block"');
  });

  test('fails closed through a finalized legacy review claim whose terminal owner recorded no PR', async () => {
    const legacyKey = 'chain:2711:phase:P1:review:2';
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'merged', taskId: 'owner-1', ownerTerminal: true, mergedAt: '2026-08-22T00:00:00.000Z', reviewVerdict: 'block', reviewedAt: '2026-08-23T09:00:00.000Z', reviewerTaskId: 'review-1', reviewAttempts: 1, reviewHeadSha: 'test-head' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), {
      mode: 'spawn',
      reachable: new Set([10]),
      terminalTasks: new Set(['legacy-review-task']),
    });
    harness.claims.set(legacyKey, {
      key: legacyKey,
      ownerToken: 'legacy-review-owner',
      claimedAt: '2026-08-23T10:00:00.000Z',
      taskId: 'legacy-review-task',
    });

    await harness.advancer.sweep();

    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.claims.get(legacyKey)).toMatchObject({ taskId: 'legacy-review-task' });
    expect(harness.claims.has('chain:kookr-ai/kookr:2711:phase:P1:review:2')).toBe(false);
    expect(harness.issue.body).toContain('"taskId": "legacy-review-task"');
    expect(harness.issue.body).toContain('"ownerTerminal": true');
    expect(harness.issue.body).not.toContain('"prNumber": 10');
    expect(harness.advancer.getHealthSnapshot().chains[0]).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('terminal-owner-no-pr:P1'),
    });
  });

  test('external projects never consult an unqualified legacy review claim', async () => {
    const externalRepo = 'example/external';
    const legacyKey = 'chain:2711:phase:P1:review:2';
    const harness = makeHarness(makeLedger({
      chainId: `chain:${externalRepo}:2711`,
      repo: externalRepo,
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'merged', taskId: 'owner-1', ownerTerminal: true, mergedAt: '2026-08-22T00:00:00.000Z', reviewVerdict: 'block', reviewedAt: '2026-08-23T09:00:00.000Z', reviewerTaskId: 'review-1', reviewAttempts: 1, reviewHeadSha: 'test-head' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), {
      mode: 'spawn',
      reachable: new Set([10]),
      terminalTasks: new Set(),
      projects: [{
        projectId: `github.com/${externalRepo}`,
        repo: externalRepo,
        repoPath: '/repos/external',
        baseBranch: 'main',
      }],
    });
    harness.claims.set(legacyKey, {
      key: legacyKey,
      ownerToken: 'legacy-review-owner',
      claimedAt: '2026-08-23T10:00:00.000Z',
      taskId: 'active-legacy-review-task',
    });

    await harness.advancer.sweep();

    expect(harness.calls).toContain('launch:chain:example/external:2711:phase:P1:review:2');
    expect(harness.claims.get(legacyKey)).toMatchObject({ taskId: 'active-legacy-review-task' });
  });

  test('fails closed when current and legacy review claims both exist', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'merged', taskId: 'owner-1', ownerTerminal: true, mergedAt: '2026-08-22T00:00:00.000Z', reviewVerdict: 'block', reviewedAt: '2026-08-23T09:00:00.000Z', reviewerTaskId: 'review-1', reviewAttempts: 1, reviewHeadSha: 'test-head' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', reachable: new Set([10]) });
    for (const key of [
      'chain:2711:phase:P1:review:2',
      'chain:kookr-ai/kookr:2711:phase:P1:review:2',
    ]) {
      harness.claims.set(key, {
        key,
        ownerToken: `owner:${key}`,
        claimedAt: '2026-08-23T10:00:00.000Z',
      });
    }

    await harness.advancer.sweep();

    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(0);
    expect(harness.events.some((event) => event.includes('both current and legacy review claims'))).toBe(true);
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
    harness.claims.set('chain:kookr-ai/kookr:2711:phase:P1', {
      key: 'chain:kookr-ai/kookr:2711:phase:P1',
      ownerToken: 'owner:chain:kookr-ai/kookr:2711:phase:P1',
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
    expect(harness.calls).toContain('launch:chain:kookr-ai/kookr:2711:phase:P1');
    expect(harness.claims.get('chain:kookr-ai/kookr:2711:phase:P1')).toMatchObject({ ownerToken: 'owner:chain:kookr-ai/kookr:2711:phase:P1' });
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

  test('single-writer guard rejects a lost update when the umbrella body changed under the sweep', async () => {
    // A concurrent writer added a phase between our read and our persist. The
    // fenced ledger has a single writer: writing our stale copy back would
    // clobber that change, so the guard must skip the update instead.
    const concurrent = makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'in-flight' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
        { id: 'P3', dependsOn: ['P2'], status: 'pending' },
      ],
    });
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'in-flight' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), {
      mode: 'spawn',
      concurrentRefetchBody: `# Umbrella\n\n${serializePhaseLedgerBlock(concurrent)}\n`,
    });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('update:'))).toHaveLength(0);
    expect(harness.events.some((event) => event.includes('WARN') && event.includes('skipped stale'))).toBe(true);
  });

  test('single-writer guard rejects a write when the refetched umbrella body is malformed', async () => {
    // The refetch parses the current remote body before writing. A body whose
    // ledger block is corrupt must abort the write rather than overwrite it.
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'in-flight' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), {
      mode: 'spawn',
      concurrentRefetchBody: '# Umbrella\n\n```kookr-phase-ledger\n{ not: valid json\n```\n',
    });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('update:'))).toHaveLength(0);
    expect(harness.events.some((event) => event.includes('WARN') && event.includes('failed to persist'))).toBe(true);
  });

  test('single-writer guard skips the write when the umbrella issue cannot be refetched', async () => {
    // Without a fresh copy of the remote body there is nothing safe to write
    // over, so the persist must abort rather than push a possibly-stale body.
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], prNumber: 10, status: 'in-flight' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', refetchReturnsNull: true });
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('update:'))).toHaveLength(0);
    expect(harness.events.some((event) => event.includes('WARN') && event.includes('could not be refetched'))).toBe(true);
  });

  test('repeated sweeps launch at most one phase task (retry idempotency)', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'spawn', terminalTasks: new Set() });
    await harness.advancer.sweep();
    // A duplicate sweep (a retry, or the periodic safety-net tick) must find the
    // persisted claim and the still-running owner task and refuse to POST a
    // second task for the same phase.
    await harness.advancer.sweep();
    await harness.advancer.sweep();
    expect(harness.calls.filter((call) => call.startsWith('launch:'))).toHaveLength(1);
    expect(harness.claims.get('chain:kookr-ai/kookr:2711:phase:P1')).toMatchObject({ taskId: 'task-next' });
  });

  test('phaseClaimKey encodes the repo-qualified contract and legacyPhaseClaimKey the unqualified one', () => {
    expect(phaseClaimKey('kookr-ai/kookr', 2711, 'P1')).toBe('chain:kookr-ai/kookr:2711:phase:P1');
    expect(phaseClaimKey('Example/Other', 42, 'Phase 3')).toBe('chain:example/other:42:phase:Phase 3');
    expect(legacyPhaseClaimKey(2711, 'P1')).toBe('chain:2711:phase:P1');
    expect(legacyPhaseClaimKey(42, 'Phase 3')).toBe('chain:42:phase:Phase 3');
  });

  test('each tick emits the structured advancer-tick schema fields', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'observe' });
    await harness.advancer.sweep();
    const tick = harness.events
      .map((line) => {
        const start = line.indexOf('{');
        if (start === -1) return undefined;
        try {
          return JSON.parse(line.slice(start)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((event) => event !== undefined && 'decision' in event);
    expect(tick).toBeDefined();
    expect(Object.keys(tick!)).toEqual(
      expect.arrayContaining(['issue', 'ledger', 'next', 'depSatisfied', 'inFlight', 'claim', 'decision', 'reason']),
    );
    expect(tick).toMatchObject({
      issue: 2711,
      ledger: 'ok',
      next: 'P1',
      depSatisfied: true,
      inFlight: false,
      decision: 'skip',
    });
    expect(typeof tick!.claim).toBe('string');
    expect(typeof tick!.reason).toBe('string');
  });

  test('chain-health rollup reports a healthy chain with the stale threshold and unstick procedure', async () => {
    const harness = makeHarness(makeLedger(), { mode: 'observe' });
    await harness.advancer.sweep();
    const rollup = harness.advancer.getHealthSnapshot();
    expect(rollup.schemaVersion).toBe('umbrella-chain-advancer.v1');
    expect(rollup.staleThresholdMs).toBeGreaterThan(0);
    expect(rollup.unstickProcedure).toContain('ledger');
    expect(rollup.chains[0]).toMatchObject({
      status: 'eligible',
      inFlight: false,
      nextPhase: 'P1',
    });
    expect(rollup.chains[0]).not.toHaveProperty('blockedReason');
  });

  test('chain-health rollup reports a blocked chain with blockedReason and blockedSince', async () => {
    const harness = makeHarness(makeLedger({
      phases: [
        { id: 'P1', dependsOn: [], status: 'in-flight', prNumber: 10, taskId: 'owner-1' },
        { id: 'P2', dependsOn: ['P1'], status: 'pending' },
      ],
    }), { mode: 'spawn', reachable: new Set() });
    await harness.advancer.sweep();
    const chain = harness.advancer.getHealthSnapshot().chains[0];
    expect(chain).toMatchObject({ status: 'blocked', blockedReason: 'dependency-unmerged' });
    expect(typeof chain?.blockedSince).toBe('string');
  });

  test('chain-health rollup marks a chain stale once it exceeds the staleness threshold', async () => {
    const base = new Date('2026-08-23T10:00:00.000Z');
    const harness = makeHarness(makeLedger(), { mode: 'observe', now: () => base });
    await harness.advancer.sweep();
    const fresh = harness.advancer.getHealthSnapshot(base.getTime());
    expect(fresh.chains[0]?.status).toBe('eligible');
    const stale = harness.advancer.getHealthSnapshot(base.getTime() + fresh.staleThresholdMs + 1);
    expect(stale.chains[0]?.status).toBe('stale');
  });
});
