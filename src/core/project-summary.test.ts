import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeProjectSummaries, checkContributionLimit, configSeedsMembership } from './project-summary.js';
import { OssAttemptStore } from './oss-attempt-store.js';
import { LedgerAnalytics } from './ledger-analytics.js';
import { ProjectConfigStore } from './project-config-store.js';
import type { AgentState } from './monitor.js';

function makeAgent(overrides: Partial<AgentState> & { agentId: string }): AgentState {
  return {
    events: [],
    anomaly: null,
    ...overrides,
  };
}

/**
 * Seed a contribution ledger with one `pr_created` entry per call. Mirrors
 * what the oss-contribution-gate hook writes in production, so the store
 * ingests it through the same `loadFromLedger` code path that the server
 * exercises at startup.
 */
function appendLedgerEntry(
  dir: string,
  entry: { timestamp: string; repo: string; prUrl: string; action?: 'pr_created' | 'slot_reset' },
): void {
  const path = join(dir, 'contribution-ledger.jsonl');
  const line = JSON.stringify({
    timestamp: entry.timestamp,
    repo: entry.repo,
    action: entry.action ?? 'pr_created',
    prUrl: entry.prUrl,
  }) + '\n';
  // Append-or-create — repeated calls build up a multi-line ledger.
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writeFileSync(path, existing + line);
}

describe('computeProjectSummaries', () => {
  let tempDir: string;
  let ossAttemptStore: OssAttemptStore;
  let ledgerAnalytics: LedgerAnalytics;
  let configStore: ProjectConfigStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'summary-test-'));
    ossAttemptStore = new OssAttemptStore(tempDir);
    ledgerAnalytics = new LedgerAnalytics(ossAttemptStore);
    configStore = new ProjectConfigStore(tempDir);
    await ossAttemptStore.load();
    await configStore.load();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('groups agents by projectId', () => {
    const agents: AgentState[] = [
      makeAgent({ agentId: 'a1', projectId: 'github.com/org/repo-a', taskStatus: 'inProgress', taskId: 'task-1' }),
      makeAgent({ agentId: 'a2', projectId: 'github.com/org/repo-a', taskStatus: 'inProgress', taskId: 'task-2' }),
      makeAgent({ agentId: 'b1', projectId: 'github.com/org/repo-b', taskStatus: 'inProgress', taskId: 'task-3' }),
    ];
    const summaries = computeProjectSummaries({ agents, ledgerAnalytics, configStore });
    expect(summaries).toHaveLength(2);
    const repoA = summaries.find((s) => s.project === 'github.com/org/repo-a')!;
    expect(repoA.activeAgents).toBe(2);
    expect(repoA.displayName).toBe('org/repo-a');
  });

  test('counts findings correctly', () => {
    const agents: AgentState[] = [
      makeAgent({
        agentId: 'a1',
        projectId: 'github.com/org/repo',
        taskStatus: 'inProgress',
        taskId: 'task-1',
        anomaly: { agentId: 'a1', type: 'needs_input', severity: 'info', explanation: 'test', detectedAt: new Date() },
      }),
      makeAgent({ agentId: 'a2', projectId: 'github.com/org/repo', taskStatus: 'inProgress', taskId: 'task-2' }),
    ];
    const summaries = computeProjectSummaries({ agents, ledgerAnalytics, configStore });
    expect(summaries[0].findingCount).toBe(1);
    expect(summaries[0].stalledAgents).toBe(1);
  });

  test('counts stalled agents only from active anomalous tasks', () => {
    const agents: AgentState[] = [
      makeAgent({
        agentId: 'a1',
        projectId: 'github.com/org/repo',
        taskStatus: 'inProgress',
        taskId: 'task-1',
        anomaly: { agentId: 'a1', type: 'needs_input', severity: 'info', explanation: 'test', detectedAt: new Date() },
      }),
      makeAgent({
        agentId: 'a2',
        projectId: 'github.com/org/repo',
        taskStatus: 'completed',
        taskId: 'task-2',
        anomaly: { agentId: 'a2', type: 'repeated_error', severity: 'warning', explanation: 'old', detectedAt: new Date() },
      }),
      makeAgent({
        agentId: 'a3',
        projectId: 'github.com/org/repo',
        taskStatus: 'inProgress',
        taskId: 'task-3',
        anomaly: { agentId: 'a3', type: 'needs_input', severity: 'info', explanation: 'snoozed', detectedAt: new Date() },
        snoozedUntil: Date.now() + 60_000,
      }),
      makeAgent({ agentId: 'a4', projectId: 'github.com/org/repo', taskStatus: 'inProgress', taskId: 'task-4' }),
    ];

    const summaries = computeProjectSummaries({ agents, ledgerAnalytics, configStore });

    expect(summaries[0].activeAgents).toBe(2);
    expect(summaries[0].stalledAgents).toBe(1);
    expect(summaries[0].findingCount).toBe(2);
  });

  test('includes projects from config store even with no agents', () => {
    configStore.setConfig('github.com/org/orphan', { dailyPrLimit: 3 });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].project).toBe('github.com/org/orphan');
    expect(summaries[0].dailyLimit).toBe(3);
  });

  test('mirrors ProjectConfig.localPath onto ProjectSummary.localPath', () => {
    configStore.setConfig('github.com/org/repo', {
      tracked: true,
      localPath: '/work/repo',
    });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries[0].localPath).toBe('/work/repo');
  });

  test('omits localPath on ProjectSummary when ProjectConfig has none', () => {
    configStore.setConfig('github.com/org/repo', { tracked: true });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries[0].localPath).toBeUndefined();
  });

  test('includes daily limit from config', () => {
    configStore.setConfig('github.com/org/repo', { dailyPrLimit: 2 });
    const agents: AgentState[] = [
      makeAgent({ agentId: 'a1', projectId: 'github.com/org/repo', taskStatus: 'inProgress', taskId: 't1' }),
    ];
    const summaries = computeProjectSummaries({ agents, ledgerAnalytics, configStore });
    expect(summaries[0].dailyLimit).toBe(2);
  });

  test('uses effective daily limit from rate-limits.json', async () => {
    writeFileSync(join(tempDir, 'rate-limits.json'), JSON.stringify({
      defaults: { maxPrsPerDay: 1 },
      overrides: { 'org/repo': { maxPrsPerDay: 3 } },
      blocked: [],
    }));
    await configStore.loadRateLimits();

    const agents: AgentState[] = [
      makeAgent({ agentId: 'a1', projectId: 'github.com/org/repo', taskStatus: 'inProgress', taskId: 't1' }),
    ];
    const summaries = computeProjectSummaries({ agents, ledgerAnalytics, configStore });
    expect(summaries[0].dailyLimit).toBe(3);
  });

  test('sorts by findings first, then active agents', () => {
    const agents: AgentState[] = [
      makeAgent({ agentId: 'a1', projectId: 'github.com/z/no-findings', taskStatus: 'inProgress', taskId: 't1' }),
      makeAgent({
        agentId: 'b1',
        projectId: 'github.com/a/has-findings',
        taskStatus: 'inProgress',
        taskId: 't2',
        anomaly: { agentId: 'b1', type: 'repeated_error', severity: 'warning', explanation: 'stuck', detectedAt: new Date() },
      }),
    ];
    const summaries = computeProjectSummaries({ agents, ledgerAnalytics, configStore });
    expect(summaries[0].project).toBe('github.com/a/has-findings');
  });

  test('skips agents without projectId', () => {
    const agents: AgentState[] = [
      makeAgent({ agentId: 'a1', taskStatus: 'inProgress', taskId: 't1' }),
    ];
    const summaries = computeProjectSummaries({ agents, ledgerAnalytics, configStore });
    expect(summaries).toHaveLength(0);
  });

  test('includes skill-discovered projects with no agents or contributions', () => {
    const summaries = computeProjectSummaries({
      agents: [],
      ledgerAnalytics,
      configStore,
      skillTrackedProjects: ['github.com/grafana/grafana', 'github.com/n8n-io/n8n'],
    });
    expect(summaries).toHaveLength(2);
    const ids = summaries.map((s) => s.project).sort();
    expect(ids).toEqual(['github.com/grafana/grafana', 'github.com/n8n-io/n8n']);
  });

  test('includes active registry projects with no agents or contributions', () => {
    const summaries = computeProjectSummaries({
      agents: [],
      ledgerAnalytics,
      configStore,
      registryActiveProjects: ['github.com/grafana/grafana'],
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].project).toBe('github.com/grafana/grafana');
  });

  test('includes sidebar-persisted projects with no agents or contributions', () => {
    const summaries = computeProjectSummaries({
      agents: [],
      ledgerAnalytics,
      configStore,
      sidebarProjects: ['github.com/example/repo'],
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].project).toBe('github.com/example/repo');
    expect(summaries[0].displayName).toBe('example/repo');
  });

  test('deduplicates between skill-discovered and manual config', () => {
    configStore.setConfig('github.com/org/repo', { tracked: true });
    const summaries = computeProjectSummaries({
      agents: [],
      ledgerAnalytics,
      configStore,
      skillTrackedProjects: ['github.com/org/repo'],
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].project).toBe('github.com/org/repo');
  });

  test('config entry with only project (no signals) does NOT seed membership', () => {
    configStore.setConfig('github.com/org/bare', {});
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries).toHaveLength(0);
  });

  test('config entry with tracked:true seeds membership', () => {
    configStore.setConfig('github.com/org/tracked', { tracked: true });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].project).toBe('github.com/org/tracked');
  });

  test('summary exposes tracked:true when user explicitly opted in', () => {
    configStore.setConfig('github.com/org/tracked', { tracked: true });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries[0].tracked).toBe(true);
  });

  test('summary exposes tracked:false when row has no explicit opt-in (skill-discovered)', () => {
    const summaries = computeProjectSummaries({
      agents: [],
      ledgerAnalytics,
      configStore,
      skillTrackedProjects: ['github.com/org/skill'],
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].tracked).toBe(false);
  });

  test('summary exposes tracked:false when config has limits/notes but tracked is not set', () => {
    configStore.setConfig('github.com/org/limits', { dailyPrLimit: 2, notes: 'plan' });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries[0].tracked).toBe(false);
  });

  test('summary exposes tracked:false when config explicitly opted out but activity keeps membership', () => {
    configStore.setConfig('github.com/org/untracked-active', { tracked: false });
    const summaries = computeProjectSummaries({
      agents: [makeAgent({
        agentId: 'a1',
        projectId: 'github.com/org/untracked-active',
        taskStatus: 'inProgress',
        taskId: 't1',
      })],
      ledgerAnalytics,
      configStore,
    });
    expect(summaries[0].tracked).toBe(false);
  });

  test('config entry with tracked:false and nothing else does not seed membership', () => {
    configStore.setConfig('github.com/org/untracked', { tracked: false });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries).toHaveLength(0);
  });

  test('config entry with only notes seeds membership', () => {
    configStore.setConfig('github.com/org/notes-only', { notes: 'some plan' });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries).toHaveLength(1);
  });

  test('config entry with empty-string notes does not seed membership', () => {
    configStore.setConfig('github.com/org/blank-notes', { notes: '   ' });
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    expect(summaries).toHaveLength(0);
  });

  test('ingested ledger PRs seed membership and produce open contribution attempt count', async () => {
    const now = new Date().toISOString();
    appendLedgerEntry(tempDir, {
      timestamp: now,
      repo: 'grafana/grafana',
      prUrl: 'https://github.com/grafana/grafana/pull/1',
    });
    await ossAttemptStore.loadFromLedger();
    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    const grafana = summaries.find((s) => s.project === 'github.com/grafana/grafana');
    expect(grafana).toBeTruthy();
    expect(grafana?.openContributionAttempts).toBe(1);
  });

  test('counts currently open contribution attempts even when they were created before the recent window', async () => {
    const oldTimestamp = new Date(Date.now() - 30 * 86_400_000).toISOString();
    appendLedgerEntry(tempDir, {
      timestamp: oldTimestamp,
      repo: 'grafana/grafana',
      prUrl: 'https://github.com/grafana/grafana/pull/1',
    });
    await ossAttemptStore.loadFromLedger();

    const summaries = computeProjectSummaries({ agents: [], ledgerAnalytics, configStore });
    const grafana = summaries.find((s) => s.project === 'github.com/grafana/grafana');

    expect(grafana).toBeTruthy();
    expect(grafana?.openContributionAttempts).toBe(1);
  });

  describe('dead local/* project filtering', () => {
    const missingChecker = { isMissing: (path: string) => path.startsWith('/tmp/gone/') };

    test('excludes a local project whose localPath is missing and has no active tasks', () => {
      configStore.setConfig('local/test_launch_abc', { tracked: true, localPath: '/tmp/gone/test_launch_abc' });
      const summaries = computeProjectSummaries({
        agents: [],
        ledgerAnalytics,
        configStore,
        localPathChecker: missingChecker,
      });
      expect(summaries).toHaveLength(0);
      // The config row is untouched — only presentation filtering.
      expect(configStore.getConfig('local/test_launch_abc')).toBeDefined();
    });

    test('keeps a local project whose localPath is missing while a task is in progress', () => {
      configStore.setConfig('local/tmp', { tracked: true, localPath: '/tmp/gone/tmp' });
      const summaries = computeProjectSummaries({
        agents: [makeAgent({ agentId: 'a-1', projectId: 'local/tmp', taskId: 't-1', taskStatus: 'inProgress' })],
        ledgerAnalytics,
        configStore,
        localPathChecker: missingChecker,
      });
      expect(summaries.map((s) => s.project)).toEqual(['local/tmp']);
    });

    test('keeps a local project whose localPath still exists', () => {
      configStore.setConfig('local/alive', { tracked: true, localPath: '/srv/checkouts/alive' });
      const summaries = computeProjectSummaries({
        agents: [],
        ledgerAnalytics,
        configStore,
        localPathChecker: missingChecker,
      });
      expect(summaries.map((s) => s.project)).toEqual(['local/alive']);
    });

    test('keeps a local project with no recorded localPath (cannot verify)', () => {
      configStore.setConfig('local/unknown-path', { tracked: true });
      const summaries = computeProjectSummaries({
        agents: [],
        ledgerAnalytics,
        configStore,
        localPathChecker: { isMissing: () => true },
      });
      expect(summaries.map((s) => s.project)).toEqual(['local/unknown-path']);
    });

    test('never filters github.com projects on the local-path check', () => {
      configStore.setConfig('github.com/octo/cat', { tracked: true, localPath: '/tmp/gone/cat' });
      const summaries = computeProjectSummaries({
        agents: [],
        ledgerAnalytics,
        configStore,
        localPathChecker: missingChecker,
      });
      expect(summaries.map((s) => s.project)).toEqual(['github.com/octo/cat']);
    });

    test('also filters sidebar-seeded dead local projects', () => {
      configStore.setConfig('local/test_launch_xyz', { localPath: '/tmp/gone/test_launch_xyz' });
      const summaries = computeProjectSummaries({
        agents: [],
        ledgerAnalytics,
        configStore,
        sidebarProjects: ['local/test_launch_xyz'],
        localPathChecker: missingChecker,
      });
      expect(summaries).toHaveLength(0);
    });
  });
});

describe('configSeedsMembership', () => {
  test('bare config returns false', () => {
    expect(configSeedsMembership({ project: 'p' })).toBe(false);
  });
  test('tracked:true returns true', () => {
    expect(configSeedsMembership({ project: 'p', tracked: true })).toBe(true);
  });
  test('tracked:false alone returns false', () => {
    expect(configSeedsMembership({ project: 'p', tracked: false })).toBe(false);
  });
  test('dailyPrLimit returns true', () => {
    expect(configSeedsMembership({ project: 'p', dailyPrLimit: 2 })).toBe(true);
  });
  test('weeklyPrLimit returns true', () => {
    expect(configSeedsMembership({ project: 'p', weeklyPrLimit: 5 })).toBe(true);
  });
  test('budgetWarnUsd returns true, including disabled zero', () => {
    expect(configSeedsMembership({ project: 'p', budgetWarnUsd: 5 })).toBe(true);
    expect(configSeedsMembership({ project: 'p', budgetWarnUsd: 0 })).toBe(true);
  });
  test('notes non-empty returns true', () => {
    expect(configSeedsMembership({ project: 'p', notes: 'hi' })).toBe(true);
  });
  test('notes all-whitespace returns false', () => {
    expect(configSeedsMembership({ project: 'p', notes: '  \n ' })).toBe(false);
  });
  test('webhook routing returns true', () => {
    expect(configSeedsMembership({ project: 'p', webhook: { enabled: false } })).toBe(true);
  });
  test('empty webhook routing returns false', () => {
    expect(configSeedsMembership({ project: 'p', webhook: {} })).toBe(false);
  });
});

describe('checkContributionLimit', () => {
  let tempDir: string;
  let ossAttemptStore: OssAttemptStore;
  let ledgerAnalytics: LedgerAnalytics;
  let configStore: ProjectConfigStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'limit-test-'));
    ossAttemptStore = new OssAttemptStore(tempDir);
    ledgerAnalytics = new LedgerAnalytics(ossAttemptStore);
    configStore = new ProjectConfigStore(tempDir);
    await ossAttemptStore.load();
    await configStore.load();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns null when no limit set', () => {
    const result = checkContributionLimit('github.com/org/repo', ledgerAnalytics, configStore);
    expect(result).toBeNull();
  });

  test('returns null when under limit', () => {
    configStore.setConfig('github.com/org/repo', { dailyPrLimit: 3 });
    const result = checkContributionLimit('github.com/org/repo', ledgerAnalytics, configStore);
    expect(result).toBeNull();
  });

  test('returns approaching when at limit - 1', async () => {
    configStore.setConfig('github.com/org/repo', { dailyPrLimit: 2 });
    appendLedgerEntry(tempDir, {
      timestamp: new Date().toISOString(),
      repo: 'org/repo',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    await ossAttemptStore.loadFromLedger();
    const result = checkContributionLimit('github.com/org/repo', ledgerAnalytics, configStore);
    expect(result?.severity).toBe('approaching');
  });

  test('returns exceeded when at limit', async () => {
    configStore.setConfig('github.com/org/repo', { dailyPrLimit: 2 });
    const now = new Date().toISOString();
    appendLedgerEntry(tempDir, {
      timestamp: now,
      repo: 'org/repo',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    appendLedgerEntry(tempDir, {
      timestamp: now,
      repo: 'org/repo',
      prUrl: 'https://github.com/org/repo/pull/2',
    });
    await ossAttemptStore.loadFromLedger();
    const result = checkContributionLimit('github.com/org/repo', ledgerAnalytics, configStore);
    expect(result?.severity).toBe('exceeded');
    expect(result?.message).toContain('2/2');
  });

  test('uses rate-limits.json effective limit', async () => {
    writeFileSync(join(tempDir, 'rate-limits.json'), JSON.stringify({
      defaults: { maxPrsPerDay: 1 },
      overrides: {},
      blocked: [],
    }));
    await configStore.loadRateLimits();

    appendLedgerEntry(tempDir, {
      timestamp: new Date().toISOString(),
      repo: 'org/repo',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    await ossAttemptStore.loadFromLedger();

    const result = checkContributionLimit('github.com/org/repo', ledgerAnalytics, configStore);
    expect(result?.severity).toBe('exceeded');
    expect(result?.message).toContain('1/1');
  });
});
