import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OssAttemptStore, projectIdToRepoVariants } from './oss-attempt-store.js';
import { LedgerAnalytics } from './ledger-analytics.js';

describe('LedgerAnalytics', () => {
  let tempDir: string;
  let store: OssAttemptStore;
  let analytics: LedgerAnalytics;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ledger-analytics-test-'));
    store = new OssAttemptStore(tempDir);
    analytics = new LedgerAnalytics(store);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getProjects', () => {
    test('returns project IDs for PR-keyed attempts', async () => {
      const today = new Date().toISOString();
      const ledger = [
        JSON.stringify({
          timestamp: today,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/42',
        }),
        JSON.stringify({
          timestamp: today,
          repo: 'rust-lang/rust',
          action: 'pr_created',
          prUrl: 'https://github.com/rust-lang/rust/pull/77',
        }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);

      await store.load();
      await store.loadFromLedger();

      expect(analytics.getProjects().sort()).toEqual([
        'github.com/grafana/grafana',
        'github.com/rust-lang/rust',
      ]);
    });

    test('excludes scouted-only records', async () => {
      await store.load();
      store.upsertScouted({ repo: 'grafana/grafana', issueNumber: 1 });
      expect(analytics.getProjects()).toEqual([]);
    });

    test('returns empty list when store has no attempts', async () => {
      await store.load();
      expect(analytics.getProjects()).toEqual([]);
    });
  });

  describe('getAttemptsByProjectRecent', () => {
    test('returns PR-keyed attempts within the last N days', async () => {
      const today = new Date().toISOString();
      writeFileSync(
        join(tempDir, 'contribution-ledger.jsonl'),
        JSON.stringify({
          timestamp: today,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/1',
        }),
      );
      await store.load();
      await store.loadFromLedger();

      const recent = analytics.getAttemptsByProjectRecent('github.com/grafana/grafana', 7);
      expect(recent).toHaveLength(1);
      expect(recent[0].prNumber).toBe(1);
    });

    test('filters by cutoff date', async () => {
      const oldTimestamp = new Date(Date.now() - 30 * 86_400_000).toISOString();
      writeFileSync(
        join(tempDir, 'contribution-ledger.jsonl'),
        JSON.stringify({
          timestamp: oldTimestamp,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/1',
        }),
      );
      await store.load();
      await store.loadFromLedger();

      expect(analytics.getAttemptsByProjectRecent('github.com/grafana/grafana', 7)).toEqual([]);
      expect(
        analytics.getAttemptsByProjectRecent('github.com/grafana/grafana', 60),
      ).toHaveLength(1);
    });

    test('excludes scouted-only records', async () => {
      await store.load();
      store.upsertScouted({ repo: 'grafana/grafana', issueNumber: 1 });
      expect(analytics.getAttemptsByProjectRecent('github.com/grafana/grafana', 7)).toEqual([]);
    });
  });

  describe('getAttemptsByProject', () => {
    test('returns PR-keyed attempts regardless of age', async () => {
      const oldTimestamp = new Date(Date.now() - 30 * 86_400_000).toISOString();
      writeFileSync(
        join(tempDir, 'contribution-ledger.jsonl'),
        JSON.stringify({
          timestamp: oldTimestamp,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/1',
        }),
      );
      await store.load();
      await store.loadFromLedger();

      const attempts = analytics.getAttemptsByProject('github.com/grafana/grafana');
      expect(attempts).toHaveLength(1);
      expect(attempts[0].prNumber).toBe(1);
    });

    test('excludes scouted-only records', async () => {
      await store.load();
      store.upsertScouted({ repo: 'grafana/grafana', issueNumber: 1 });
      expect(analytics.getAttemptsByProject('github.com/grafana/grafana')).toEqual([]);
    });
  });

  describe('getTodayCount', () => {
    test('subtracts slot_reset entries from today-only pr_created entries', async () => {
      const today = new Date().toISOString().split('T')[0];
      const ledger = [
        JSON.stringify({
          timestamp: `${today}T10:00:00Z`,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/1',
        }),
        JSON.stringify({
          timestamp: `${today}T11:00:00Z`,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/2',
        }),
        JSON.stringify({
          timestamp: `${today}T12:00:00Z`,
          repo: 'grafana/grafana',
          action: 'slot_reset',
          reason: 'user reset',
        }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);
      await store.load();
      await store.loadFromLedger();

      expect(analytics.getTodayCount('github.com/grafana/grafana')).toBe(1);
    });

    test('never goes negative', async () => {
      const today = new Date().toISOString().split('T')[0];
      writeFileSync(
        join(tempDir, 'contribution-ledger.jsonl'),
        [
          JSON.stringify({ timestamp: `${today}T10:00:00Z`, repo: 'grafana/grafana', action: 'slot_reset' }),
          JSON.stringify({ timestamp: `${today}T11:00:00Z`, repo: 'grafana/grafana', action: 'slot_reset' }),
        ].join('\n'),
      );
      await store.load();
      await store.loadFromLedger();

      expect(analytics.getTodayCount('github.com/grafana/grafana')).toBe(0);
    });

    test('ignores entries from other projects and other days', async () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
      const ledger = [
        JSON.stringify({
          timestamp: `${yesterday}T10:00:00Z`,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/0',
        }),
        JSON.stringify({
          timestamp: `${today}T10:00:00Z`,
          repo: 'rust-lang/rust',
          action: 'pr_created',
          prUrl: 'https://github.com/rust-lang/rust/pull/9',
        }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);
      await store.load();
      await store.loadFromLedger();

      expect(analytics.getTodayCount('github.com/grafana/grafana')).toBe(0);
      expect(analytics.getTodayCount('github.com/rust-lang/rust')).toBe(1);
    });
  });

  describe('getWeekCount', () => {
    test('counts pr_created entries within the last 7 days', async () => {
      const today = new Date().toISOString();
      const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
      const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
      const ledger = [
        JSON.stringify({
          timestamp: today,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/3',
        }),
        JSON.stringify({
          timestamp: sixDaysAgo,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/2',
        }),
        JSON.stringify({
          timestamp: eightDaysAgo,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/1',
        }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);
      await store.load();
      await store.loadFromLedger();

      expect(analytics.getWeekCount('github.com/grafana/grafana')).toBe(2);
    });

    test('ignores non-pr_created entries', async () => {
      const today = new Date().toISOString();
      const ledger = [
        JSON.stringify({ timestamp: today, repo: 'grafana/grafana', action: 'slot_reset' }),
        JSON.stringify({
          timestamp: today,
          repo: 'grafana/grafana',
          action: 'pr_blocked_rate_limit',
          blockReason: 'Rate limit',
        }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);
      await store.load();
      await store.loadFromLedger();

      expect(analytics.getWeekCount('github.com/grafana/grafana')).toBe(0);
    });
  });

  describe('getTodayBlockedEntries', () => {
    test('returns only today-rate-limited and today-blocked-repo entries', async () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
      const ledger = [
        JSON.stringify({
          timestamp: `${today}T10:00:00Z`,
          repo: 'grafana/grafana',
          action: 'pr_blocked_rate_limit',
          blockReason: 'Rate limit',
        }),
        JSON.stringify({
          timestamp: `${today}T11:00:00Z`,
          repo: 'ggml-org/llama.cpp',
          action: 'pr_blocked_blocked_repo',
          blockReason: 'Blocked repo',
        }),
        JSON.stringify({
          timestamp: `${yesterday}T10:00:00Z`,
          repo: 'grafana/grafana',
          action: 'pr_blocked_rate_limit',
          blockReason: 'Stale',
        }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);
      await store.load();
      await store.loadFromLedger();

      const blocked = analytics.getTodayBlockedEntries();
      expect(blocked).toHaveLength(2);
      expect(blocked.map((e) => e.action).sort()).toEqual([
        'pr_blocked_blocked_repo',
        'pr_blocked_rate_limit',
      ]);
    });

    test('returns empty list when ledger has no blocked entries', async () => {
      await store.load();
      expect(analytics.getTodayBlockedEntries()).toEqual([]);
    });
  });

  describe('batch aggregation equivalence', () => {
    test('batch maps equal the per-project methods across a fixture ledger', async () => {
      const today = new Date().toISOString().split('T')[0];
      const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
      const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
      const ledger = [
        // grafana: 2 created today, 1 slot_reset today -> todayCount 1
        JSON.stringify({ timestamp: `${today}T09:00:00Z`, repo: 'grafana/grafana', action: 'pr_created', prUrl: 'https://github.com/grafana/grafana/pull/1' }),
        JSON.stringify({ timestamp: `${today}T10:00:00Z`, repo: 'grafana/grafana', action: 'pr_created', prUrl: 'https://github.com/grafana/grafana/pull/2' }),
        JSON.stringify({ timestamp: `${today}T11:00:00Z`, repo: 'grafana/grafana', action: 'slot_reset', reason: 'user reset' }),
        // grafana: one within the week, one older than the week
        JSON.stringify({ timestamp: sixDaysAgo, repo: 'grafana/grafana', action: 'pr_created', prUrl: 'https://github.com/grafana/grafana/pull/3' }),
        JSON.stringify({ timestamp: eightDaysAgo, repo: 'grafana/grafana', action: 'pr_created', prUrl: 'https://github.com/grafana/grafana/pull/4' }),
        // rust-lang: 1 created today
        JSON.stringify({ timestamp: `${today}T08:00:00Z`, repo: 'rust-lang/rust', action: 'pr_created', prUrl: 'https://github.com/rust-lang/rust/pull/9' }),
        // llama.cpp: only a blocked entry -> no created/week rows, but has no attempt either
        JSON.stringify({ timestamp: `${today}T07:00:00Z`, repo: 'ggml-org/llama.cpp', action: 'pr_blocked_rate_limit', blockReason: 'Rate limit' }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);
      await store.load();
      await store.loadFromLedger();

      // Include a local/non-GitHub project that should resolve to 0/empty, and
      // a GitHub project present in the ledger only via a blocked entry.
      const projectIds = [
        'github.com/grafana/grafana',
        'github.com/rust-lang/rust',
        'github.com/ggml-org/llama.cpp',
        'local/my-checkout',
      ];

      const todayCounts = analytics.getTodayCountsByProject(projectIds);
      const weekCounts = analytics.getWeekCountsByProject(projectIds);
      const attemptsMap = analytics.getAttemptsByProjectMap(projectIds);

      // Every requested project appears as a key, even with no matching rows.
      expect([...todayCounts.keys()].sort()).toEqual([...projectIds].sort());
      expect([...weekCounts.keys()].sort()).toEqual([...projectIds].sort());
      expect([...attemptsMap.keys()].sort()).toEqual([...projectIds].sort());

      for (const projectId of projectIds) {
        expect(todayCounts.get(projectId)).toBe(analytics.getTodayCount(projectId));
        expect(weekCounts.get(projectId)).toBe(analytics.getWeekCount(projectId));
        expect(attemptsMap.get(projectId)).toEqual(analytics.getAttemptsByProject(projectId));
      }

      // Spot-check the derived values so the equivalence isn't 0-vs-0 trivial.
      expect(todayCounts.get('github.com/grafana/grafana')).toBe(1);
      // 2 created today + 1 six days ago are within the week; 8-days-ago is not.
      expect(weekCounts.get('github.com/grafana/grafana')).toBe(3);
      expect(todayCounts.get('github.com/rust-lang/rust')).toBe(1);
      expect(todayCounts.get('local/my-checkout')).toBe(0);
      expect(weekCounts.get('local/my-checkout')).toBe(0);
      expect(attemptsMap.get('local/my-checkout')).toEqual([]);
    });

    test('credits every project that shares a repo variant, not just the first', async () => {
      // Two project IDs on different hosts collapse to the same `owner/repo`
      // variant, so one ledger row must credit both — exercises the
      // `for (const projectId of matched)` fan-out that a single-project
      // ledger can never reach.
      const today = new Date().toISOString().split('T')[0];
      const ledger = [
        JSON.stringify({ timestamp: `${today}T09:00:00Z`, repo: 'acme/app', action: 'pr_created', prUrl: 'https://github.com/acme/app/pull/1' }),
        JSON.stringify({ timestamp: `${today}T10:00:00Z`, repo: 'acme/app', action: 'pr_created', prUrl: 'https://github.com/acme/app/pull/2' }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);
      await store.load();
      await store.loadFromLedger();

      const ids = ['github.com/acme/app', 'gitlab.com/acme/app'];
      expect(projectIdToRepoVariants('github.com/acme/app')).toEqual(['acme/app']);
      expect(projectIdToRepoVariants('gitlab.com/acme/app')).toEqual(['acme/app']);

      const todayCounts = analytics.getTodayCountsByProject(ids);
      const weekCounts = analytics.getWeekCountsByProject(ids);
      const attemptsMap = analytics.getAttemptsByProjectMap(ids);
      for (const id of ids) {
        expect(todayCounts.get(id)).toBe(2);
        expect(weekCounts.get(id)).toBe(2);
        expect(attemptsMap.get(id)).toHaveLength(2);
        // Equivalent to the per-project method for each shared-variant project.
        expect(todayCounts.get(id)).toBe(analytics.getTodayCount(id));
        expect(attemptsMap.get(id)).toEqual(analytics.getAttemptsByProject(id));
      }
    });

    test('batch today count clamps a net-negative project to zero', async () => {
      // The batch clamp (`Math.max(0, value)`) is a separate code path from the
      // per-project one, so pin it directly with a project whose resets exceed
      // its creations.
      const today = new Date().toISOString().split('T')[0];
      const ledger = [
        JSON.stringify({ timestamp: `${today}T09:00:00Z`, repo: 'grafana/grafana', action: 'pr_created', prUrl: 'https://github.com/grafana/grafana/pull/1' }),
        JSON.stringify({ timestamp: `${today}T10:00:00Z`, repo: 'grafana/grafana', action: 'slot_reset' }),
        JSON.stringify({ timestamp: `${today}T11:00:00Z`, repo: 'grafana/grafana', action: 'slot_reset' }),
      ].join('\n');
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);
      await store.load();
      await store.loadFromLedger();

      const counts = analytics.getTodayCountsByProject(['github.com/grafana/grafana']);
      expect(counts.get('github.com/grafana/grafana')).toBe(0);
      expect(counts.get('github.com/grafana/grafana')).toBe(analytics.getTodayCount('github.com/grafana/grafana'));
    });

    test('scans the ledger a constant number of times regardless of project count', async () => {
      const today = new Date().toISOString().split('T')[0];
      writeFileSync(
        join(tempDir, 'contribution-ledger.jsonl'),
        JSON.stringify({ timestamp: `${today}T09:00:00Z`, repo: 'grafana/grafana', action: 'pr_created', prUrl: 'https://github.com/grafana/grafana/pull/1' }),
      );
      await store.load();
      await store.loadFromLedger();

      let ledgerScans = 0;
      let attemptScans = 0;
      const countingSource = {
        getAllLedgerEntries: () => {
          ledgerScans += 1;
          return store.getAllLedgerEntries();
        },
        getAttemptsReadonly: () => {
          attemptScans += 1;
          return store.getAttemptsReadonly();
        },
      };
      const counting = new LedgerAnalytics(countingSource);
      const manyProjects = Array.from({ length: 25 }, (_, i) => `github.com/owner/repo-${i}`);

      counting.getTodayCountsByProject(manyProjects);
      counting.getWeekCountsByProject(manyProjects);
      counting.getAttemptsByProjectMap(manyProjects);

      // One ledger scan per count method, one attempt scan for the map — not
      // one-per-project as the old per-project loop did.
      expect(ledgerScans).toBe(2);
      expect(attemptScans).toBe(1);
    });
  });

  test('constructor accepts a bare source object satisfying the interface', () => {
    const source = {
      getAllLedgerEntries: () => [
        {
          timestamp: new Date().toISOString(),
          repo: 'grafana/grafana',
          action: 'pr_blocked_rate_limit' as const,
        },
      ],
      getAttemptsReadonly: () => [],
    };
    const stubAnalytics = new LedgerAnalytics(source);
    expect(stubAnalytics.getTodayBlockedEntries()).toHaveLength(1);
    expect(stubAnalytics.getProjects()).toEqual([]);
  });
});
