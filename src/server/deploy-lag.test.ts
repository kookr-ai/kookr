import { describe, expect, it, vi } from 'vitest';

import {
  COMMIT_LOG_FORMAT,
  DEFAULT_DEPLOY_LAG_THRESHOLD_MS,
  diffAgainstMain,
  evaluateDeployLag,
  extractGitSha,
  formatPendingCommits,
  gitShaLike,
  parseCommitLog,
  resolveDeployLagConfig,
  targetResultToCheckResult,
  type DeployLagTargetSnapshot,
  type GitReader,
  type PendingCommit,
} from './deploy-lag.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0); // fixed clock for age math

function commit(overrides: Partial<PendingCommit> = {}): PendingCommit {
  return { shortSha: 'abc1234', committedAtMs: NOW - HOUR_MS, subject: 'fix: something', ...overrides };
}

describe('parseCommitLog', () => {
  it('parses unit-separated %h/%ct/%s lines newest-first', () => {
    const stdout = ['def5678\x1f1750000000\x1ffeat: b', 'abc1234\x1f1749990000\x1ffix: a'].join('\n');
    expect(parseCommitLog(stdout)).toEqual([
      { shortSha: 'def5678', committedAtMs: 1750000000_000, subject: 'feat: b' },
      { shortSha: 'abc1234', committedAtMs: 1749990000_000, subject: 'fix: a' },
    ]);
  });

  it('keeps separators inside a subject and skips blank/malformed lines', () => {
    const stdout = ['\n', 'abc1234\x1f1749990000\x1ffix: a\x1fnote', 'garbage-with-no-sep', 'zzz\x1fNaN\x1fbad-ts'].join(
      '\n',
    );
    expect(parseCommitLog(stdout)).toEqual([
      { shortSha: 'abc1234', committedAtMs: 1749990000_000, subject: 'fix: a\x1fnote' },
    ]);
  });
});

describe('gitShaLike / extractGitSha', () => {
  it('recognises abbreviated and full hex object ids only', () => {
    expect(gitShaLike('2437099')).toBe(true);
    expect(gitShaLike('a'.repeat(40))).toBe(true);
    expect(gitShaLike('main')).toBe(false);
    expect(gitShaLike('123')).toBe(false); // too short
    expect(gitShaLike('zzzzzzz')).toBe(false);
  });

  it('extracts a SHA from common top-level and nested status shapes', () => {
    expect(extractGitSha({ GIT_SHA: '2437099' })).toBe('2437099');
    expect(extractGitSha({ gitSha: 'abcdef1234567890' })).toBe('abcdef1234567890');
    expect(extractGitSha({ build: { commitHash: 'deadbeef' } })).toBe('deadbeef');
    expect(extractGitSha({ nothing: 'here' })).toBeNull();
    expect(extractGitSha('not-an-object')).toBeNull();
  });

  it('honours a caller-provided field ahead of the defaults', () => {
    expect(extractGitSha({ live_sha: 'cafe1234' }, ['live_sha'])).toBe('cafe1234');
  });
});

describe('formatPendingCommits', () => {
  it('names each commit and caps the list with an overflow marker', () => {
    const commits = Array.from({ length: 12 }, (_, i) => commit({ shortSha: `sha${i}`, subject: `s${i}` }));
    const out = formatPendingCommits(commits, 10);
    expect(out.startsWith('sha0 s0; ')).toBe(true);
    expect(out).toContain('…(+2 more)');
  });

  it('returns (none) for an empty list', () => {
    expect(formatPendingCommits([])).toBe('(none)');
  });
});

describe('evaluateDeployLag', () => {
  const base = { nowMs: NOW, thresholdMs: DEFAULT_DEPLOY_LAG_THRESHOLD_MS };

  it('AC: up-to-date when deployed SHA equals origin/main', () => {
    const snapshot: DeployLagTargetSnapshot = {
      target: 'kookr',
      deployedSha: 'f'.repeat(40),
      mainSha: 'f'.repeat(40),
      pendingCommits: [],
    };
    const r = evaluateDeployLag({ snapshot, ...base });
    expect(r.status).toBe('up-to-date');
    expect(r.ok).toBe(true);
  });

  it('AC3: a freshly merged commit under the threshold raises no alert', () => {
    const snapshot: DeployLagTargetSnapshot = {
      target: 'kookr',
      deployedSha: 'a'.repeat(40),
      mainSha: 'b'.repeat(40),
      pendingCommits: [commit({ committedAtMs: NOW - 1 * HOUR_MS })], // 1h < 6h
    };
    const r = evaluateDeployLag({ snapshot, ...base });
    expect(r.status).toBe('within-threshold');
    expect(r.ok).toBe(true);
    expect(r.lagMs).toBe(1 * HOUR_MS);
  });

  it('AC1/AC2: lag past the threshold alerts and names the pending commits', () => {
    const pending = [
      commit({ shortSha: 'def5678', subject: 'fix: model 410', committedAtMs: NOW - 2 * HOUR_MS }),
      commit({ shortSha: '2437099', subject: 'fix: nemotron deprecation', committedAtMs: NOW - 7 * HOUR_MS }),
    ];
    const snapshot: DeployLagTargetSnapshot = {
      target: 'lucy',
      deployedSha: 'a'.repeat(40),
      mainSha: 'b'.repeat(40),
      pendingCommits: pending,
    };
    const r = evaluateDeployLag({ snapshot, ...base });
    expect(r.status).toBe('lagging');
    expect(r.ok).toBe(false);
    // oldest pending commit is 7h old → past the 6h threshold
    expect(r.lagMs).toBe(7 * HOUR_MS);
    expect(r.detail).toContain('def5678 fix: model 410');
    expect(r.detail).toContain('2437099 fix: nemotron deprecation');
    expect(r.detail).toContain('past the');
  });

  it('exactly at the threshold alerts (>= boundary); one ms under does not', () => {
    const atThreshold: DeployLagTargetSnapshot = {
      target: 'kookr',
      deployedSha: 'a'.repeat(40),
      mainSha: 'b'.repeat(40),
      pendingCommits: [commit({ committedAtMs: NOW - DEFAULT_DEPLOY_LAG_THRESHOLD_MS })],
    };
    expect(evaluateDeployLag({ snapshot: atThreshold, ...base }).status).toBe('lagging');
    const justUnder: DeployLagTargetSnapshot = {
      ...atThreshold,
      pendingCommits: [commit({ committedAtMs: NOW - (DEFAULT_DEPLOY_LAG_THRESHOLD_MS - 1) })],
    };
    expect(evaluateDeployLag({ snapshot: justUnder, ...base }).status).toBe('within-threshold');
  });

  it('SHAs differ but nothing is pending (deployed ahead / diverged) → up-to-date, not "== origin/main"', () => {
    const snapshot: DeployLagTargetSnapshot = {
      target: 'kookr',
      deployedSha: 'a'.repeat(40),
      mainSha: 'b'.repeat(40),
      pendingCommits: [],
    };
    const r = evaluateDeployLag({ snapshot, ...base });
    expect(r.status).toBe('up-to-date');
    expect(r.detail).toContain('no undeployed commits');
    expect(r.detail).not.toContain('== origin/main');
  });

  it('unknown (never alerts) when either SHA cannot be resolved', () => {
    const noDeployed: DeployLagTargetSnapshot = {
      target: 'lucy',
      deployedSha: null,
      mainSha: 'b'.repeat(40),
      pendingCommits: [],
      unavailableReason: 'lucy status surface unreachable',
    };
    const rd = evaluateDeployLag({ snapshot: noDeployed, ...base });
    expect(rd.status).toBe('unknown');
    expect(rd.ok).toBe(true);
    expect(rd.detail).toContain('lucy status surface unreachable');

    // Symmetric: deployed resolved but origin/main unresolved.
    const noMain: DeployLagTargetSnapshot = {
      target: 'kookr',
      deployedSha: 'a'.repeat(40),
      mainSha: null,
      pendingCommits: [],
      unavailableReason: 'could not resolve origin/main',
    };
    const rm = evaluateDeployLag({ snapshot: noMain, ...base });
    expect(rm.status).toBe('unknown');
    expect(rm.ok).toBe(true);
  });

  it('maps a lagging result to a failing CheckResult named per target', () => {
    const check = targetResultToCheckResult({
      target: 'kookr',
      status: 'lagging',
      ok: false,
      deployedSha: 'a',
      mainSha: 'b',
      pendingCommits: [],
      lagMs: 10 * HOUR_MS,
      detail: 'kookr lagging',
    });
    expect(check).toEqual({ name: 'deploy-lag:kookr', ok: false, detail: 'kookr lagging' });
  });
});

describe('diffAgainstMain (resolver core, read-only)', () => {
  function fakeGit(responses: Record<string, string | null>): { git: GitReader; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitReader = async (_cwd, args) => {
      calls.push(args);
      const key = args.join(' ');
      return key in responses ? responses[key]! : null;
    };
    return { git, calls };
  }

  it('AC2: a checkout pinned behind origin/main yields the pending commits', async () => {
    const deployed = 'a'.repeat(40);
    const main = 'b'.repeat(40);
    const { git, calls } = fakeGit({
      'fetch --quiet origin main': '',
      [`rev-parse --verify --quiet ${deployed}^{commit}`]: deployed,
      'rev-parse --verify --quiet origin/main^{commit}': main,
      [`log --first-parent --format=${COMMIT_LOG_FORMAT} ${deployed}..${main}`]: `${'c'.repeat(7)}\x1f1749990000\x1ffeat: x`,
    });
    const snap = await diffAgainstMain({
      target: 'kookr',
      rawDeployedSha: deployed,
      repoPath: '/repo',
      git,
      fetchBeforeCompare: true,
    });
    expect(snap.deployedSha).toBe(deployed);
    expect(snap.mainSha).toBe(main);
    expect(snap.pendingCommits).toHaveLength(1);
    // AC4: only read-only git verbs are ever invoked — never a deploy/mutation.
    for (const args of calls) {
      expect(['fetch', 'rev-parse', 'log']).toContain(args[0]);
    }
    // Merge-time semantics: the log walks origin/main's first-parent line so a
    // commit's committer date is its merge time regardless of merge strategy.
    expect(calls.some((a) => a[0] === 'log' && a.includes('--first-parent'))).toBe(true);
  });

  it('a failed git log (null, not empty) degrades to unknown, never "nothing pending"', async () => {
    const deployed = 'a'.repeat(40);
    const main = 'b'.repeat(40);
    const { git } = fakeGit({
      'fetch --quiet origin main': '',
      [`rev-parse --verify --quiet ${deployed}^{commit}`]: deployed,
      'rev-parse --verify --quiet origin/main^{commit}': main,
      // log key absent ⇒ fakeGit returns null (simulating timeout / maxBuffer).
    });
    const snap = await diffAgainstMain({
      target: 'kookr',
      rawDeployedSha: deployed,
      repoPath: '/repo',
      git,
      fetchBeforeCompare: true,
    });
    expect(snap.deployedSha).toBeNull();
    expect(snap.unavailableReason).toContain('git log');
  });

  it('an empty (not null) log with differing SHAs means nothing pending → resolves cleanly', async () => {
    const deployed = 'a'.repeat(40);
    const main = 'b'.repeat(40);
    const { git } = fakeGit({
      'fetch --quiet origin main': '',
      [`rev-parse --verify --quiet ${deployed}^{commit}`]: deployed,
      'rev-parse --verify --quiet origin/main^{commit}': main,
      [`log --first-parent --format=${COMMIT_LOG_FORMAT} ${deployed}..${main}`]: '',
    });
    const snap = await diffAgainstMain({
      target: 'kookr',
      rawDeployedSha: deployed,
      repoPath: '/repo',
      git,
      fetchBeforeCompare: true,
    });
    expect(snap.deployedSha).toBe(deployed);
    expect(snap.mainSha).toBe(main);
    expect(snap.pendingCommits).toEqual([]);
    expect(snap.unavailableReason).toBeUndefined();
  });

  it('warns (does not silently swallow) when the pre-compare fetch fails', async () => {
    const deployed = 'a'.repeat(40);
    const warn = vi.fn();
    const git: GitReader = async (_cwd, args) => {
      if (args[0] === 'fetch') return null; // fetch failure
      if (args[0] === 'rev-parse') return deployed; // both SHAs equal ⇒ up to date
      return '';
    };
    const snap = await diffAgainstMain({
      target: 'kookr',
      rawDeployedSha: deployed,
      repoPath: '/repo',
      git,
      fetchBeforeCompare: true,
      logger: { warn },
    });
    expect(snap.deployedSha).toBe(deployed);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('fetch');
  });

  it('normalizes a short (lucy-style) SHA to a full oid before comparing', async () => {
    const full = 'd'.repeat(40);
    const main = 'e'.repeat(40);
    const { git } = fakeGit({
      'fetch --quiet origin main': '',
      'rev-parse --verify --quiet 2437099^{commit}': full,
      'rev-parse --verify --quiet origin/main^{commit}': main,
      [`log --first-parent --format=${COMMIT_LOG_FORMAT} ${full}..${main}`]: `${'f'.repeat(7)}\x1f1749990000\x1ffix: y`,
    });
    const snap = await diffAgainstMain({
      target: 'lucy',
      rawDeployedSha: '2437099',
      repoPath: '/lucy',
      git,
      fetchBeforeCompare: true,
    });
    expect(snap.deployedSha).toBe(full);
    expect(snap.pendingCommits).toHaveLength(1);
  });

  it('reports unknown when the deployed SHA is missing from the local clone', async () => {
    const { git } = fakeGit({ 'fetch --quiet origin main': '' });
    const snap = await diffAgainstMain({
      target: 'lucy',
      rawDeployedSha: 'deadbee',
      repoPath: '/lucy',
      git,
      fetchBeforeCompare: true,
    });
    expect(snap.deployedSha).toBeNull();
    expect(snap.unavailableReason).toContain('not found');
  });

  it('skips the fetch when fetchBeforeCompare is false', async () => {
    const deployed = 'a'.repeat(40);
    const { git, calls } = fakeGit({
      [`rev-parse --verify --quiet ${deployed}^{commit}`]: deployed,
      'rev-parse --verify --quiet origin/main^{commit}': deployed,
    });
    await diffAgainstMain({ target: 'kookr', rawDeployedSha: deployed, repoPath: '/repo', git, fetchBeforeCompare: false });
    expect(calls.some((a) => a[0] === 'fetch')).toBe(false);
  });
});

describe('resolveDeployLagConfig', () => {
  it('defaults threshold to 6h, fetch on, and no lucy target', () => {
    const cfg = resolveDeployLagConfig({}, '/server/cwd');
    expect(cfg.thresholdMs).toBe(DEFAULT_DEPLOY_LAG_THRESHOLD_MS);
    expect(cfg.fetchBeforeCompare).toBe(true);
    expect(cfg.kookrRepoPath).toBe('/server/cwd');
    expect(cfg.lucyStatusUrl).toBeUndefined();
    expect(cfg.lucyRepoPath).toBeUndefined();
  });

  it('reads overrides from the environment', () => {
    const cfg = resolveDeployLagConfig(
      {
        KOOKR_DEPLOY_LAG_THRESHOLD_HOURS: '2',
        KOOKR_DEPLOY_LAG_FETCH: '0',
        KOOKR_DEPLOY_LAG_KOOKR_REPO: '/custom',
        KOOKR_DEPLOY_LAG_LUCY_STATUS_URL: 'http://lucy/status',
        KOOKR_DEPLOY_LAG_LUCY_REPO: '/lucy',
        KOOKR_DEPLOY_LAG_LUCY_SHA_FIELD: 'live_sha',
      },
      '/server/cwd',
    );
    expect(cfg.thresholdMs).toBe(2 * HOUR_MS);
    expect(cfg.fetchBeforeCompare).toBe(false);
    expect(cfg.kookrRepoPath).toBe('/custom');
    expect(cfg.lucyStatusUrl).toBe('http://lucy/status');
    expect(cfg.lucyRepoPath).toBe('/lucy');
    expect(cfg.lucyShaFields[0]).toBe('live_sha');
  });

  it('falls back to the default threshold on a non-positive or malformed value', () => {
    expect(resolveDeployLagConfig({ KOOKR_DEPLOY_LAG_THRESHOLD_HOURS: '0' }, '/x').thresholdMs).toBe(
      DEFAULT_DEPLOY_LAG_THRESHOLD_MS,
    );
    expect(resolveDeployLagConfig({ KOOKR_DEPLOY_LAG_THRESHOLD_HOURS: '6h' }, '/x').thresholdMs).toBe(
      DEFAULT_DEPLOY_LAG_THRESHOLD_MS,
    );
  });
});
