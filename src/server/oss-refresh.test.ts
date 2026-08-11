import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OssAttemptStore } from '../core/oss-attempt-store.js';
import { OssRefresher, extractAllIssueNumbersFromBody } from './oss-refresh.js';

/** Fixture timestamps kept inside the default 90d OSS attempt retention window
 *  so prune-on-save does not drop terminal records mid-test (issue #2286). */
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();
const FIX_T_CREATED = daysAgo(20); // was 2026-04-01
const FIX_T_MERGED = daysAgo(16);  // was 2026-04-05
const FIX_T_UPDATED = daysAgo(11); // was 2026-04-10
const FIX_T_CLOSED = daysAgo(9);   // was 2026-04-12
const FIX_T_CLOSED_LATE = daysAgo(8); // was 2026-04-13


describe('extractAllIssueNumbersFromBody', () => {
  test('matches "Fixes #N" case-insensitively (migrated from singular test)', () => {
    expect(extractAllIssueNumbersFromBody('Fixes #42')).toEqual([42]);
    expect(extractAllIssueNumbersFromBody('fixes #42')).toEqual([42]);
    expect(extractAllIssueNumbersFromBody('FIXES #42')).toEqual([42]);
  });
  test('matches "Closes #N" and "Resolves #N"', () => {
    expect(extractAllIssueNumbersFromBody('Closes #123')).toEqual([123]);
    expect(extractAllIssueNumbersFromBody('Resolves #7')).toEqual([7]);
  });
  test('ignores #N without a closing keyword', () => {
    expect(extractAllIssueNumbersFromBody('see #42 for context')).toEqual([]);
    expect(extractAllIssueNumbersFromBody('related to #99')).toEqual([]);
  });
  test('returns ALL matches in order when multiple are present (multi-issue)', () => {
    expect(extractAllIssueNumbersFromBody('Fixes #10 and closes #20')).toEqual([10, 20]);
    expect(extractAllIssueNumbersFromBody('Resolves #3, fixes #7, closes #9')).toEqual([3, 7, 9]);
  });
  test('deduplicates repeated references', () => {
    expect(extractAllIssueNumbersFromBody('Fixes #42 and also fixes #42')).toEqual([42]);
  });
  test('handles multi-line bodies with surrounding text', () => {
    const body = `## Summary\n\nFixes #25425\n\nRemoves the guard...`;
    expect(extractAllIssueNumbersFromBody(body)).toEqual([25425]);
  });
  test('null/empty/undefined → []', () => {
    expect(extractAllIssueNumbersFromBody(null)).toEqual([]);
    expect(extractAllIssueNumbersFromBody(undefined)).toEqual([]);
    expect(extractAllIssueNumbersFromBody('')).toEqual([]);
  });
  test('the one call site migration contract: [0] ?? null is null on empty', () => {
    // The scout-dedup call site (oss-refresh.ts `newlyClosed` block) does
    // `extractAllIssueNumbersFromBody(...)[0] ?? null`. This must behave
    // identically to the old singular function for single-match and no-match
    // inputs — the semantic it depends on.
    expect(extractAllIssueNumbersFromBody('Fixes #42')[0] ?? null).toBe(42);
    expect(extractAllIssueNumbersFromBody('no keywords here')[0] ?? null).toBeNull();
    expect(extractAllIssueNumbersFromBody(null)[0] ?? null).toBeNull();
  });
});

function fakeGhFactory(responses: Record<string, string>) {
  const calls: string[][] = [];
  const runGh = async (args: string[]) => {
    calls.push(args);
    const key = args.join(' ');
    for (const [pattern, body] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return { stdout: body, stderr: '' };
      }
    }
    throw new Error(`unexpected gh invocation: ${key}`);
  };
  return { runGh, calls };
}

describe('OssRefresher', () => {
  let tempDir: string;
  let store: OssAttemptStore;
  let registryPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oss-refresh-test-'));
    store = new OssAttemptStore(tempDir);
    registryPath = join(tempDir, 'oss-repos.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        repos: {
          'grafana/grafana': { status: 'active' },
          'rust-lang/rust': { status: 'active' },
          'kookr-ai/kookr': { status: 'active' }, // own → skipped
          'bad/anti-ai': { status: 'anti-ai' }, // ineligible → skipped
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('loads only external active repos from registry', async () => {
    const { runGh, calls } = fakeGhFactory({
      'grafana/grafana': '[]',
      'pr list --repo rust-lang/rust': '[]',
    });
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();
    expect(result.ok).toBe(true);
    expect(result.reposTotal).toBe(2);
    expect(result.reposProcessed).toBe(2);
    const listCalls = calls.filter((c) => c[1] === 'list');
    expect(listCalls).toHaveLength(2);
    const listedRepos = listCalls.map((c) => c[c.indexOf('--repo') + 1]).sort();
    expect(listedRepos).toEqual(['grafana/grafana', 'rust-lang/rust']);
  });

  test('upserts PR records from gh pr list output', async () => {
    await store.load();
    const { runGh } = fakeGhFactory({
      'pr list --repo grafana/grafana': JSON.stringify([
        {
          number: 100,
          title: 'Fix dashboard bug',
          url: 'https://github.com/grafana/grafana/pull/100',
          state: 'MERGED',
          createdAt: FIX_T_CREATED,
          mergedAt: FIX_T_MERGED,
          closedAt: null,
          updatedAt: FIX_T_MERGED,
        },
      ]),
      'pr list --repo rust-lang/rust': '[]',
    });
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();
    const attempts = store.getByRepo('grafana/grafana');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe('merged');
    expect(attempts[0].prUrl).toBe('https://github.com/grafana/grafana/pull/100');
  });

  test('fetches closing details for newly-closed PRs', async () => {
    await store.load();
    const { runGh, calls } = fakeGhFactory({
      'pr list --repo grafana/grafana': JSON.stringify([
        {
          number: 100,
          title: 'Rejected fix',
          url: 'https://github.com/grafana/grafana/pull/100',
          state: 'CLOSED',
          createdAt: FIX_T_CREATED,
          mergedAt: null,
          closedAt: FIX_T_MERGED,
          updatedAt: FIX_T_MERGED,
        },
      ]),
      'pr list --repo rust-lang/rust': '[]',
      'pr view https://github.com/grafana/grafana/pull/100': JSON.stringify({
        state: 'CLOSED',
        mergedAt: null,
        closedAt: FIX_T_MERGED,
        comments: [
          {
            author: { login: 'maintainer' },
            body: 'This duplicates #123 — closing.',
            createdAt: FIX_T_MERGED,
          },
        ],
      }),
    });
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();
    const attempt = store.getByRepo('grafana/grafana')[0];
    expect(attempt.closing).not.toBeNull();
    expect(attempt.closing?.closerLogin).toBe('maintainer');
    expect(attempt.closing?.closingComment).toContain('duplicates');
    // Ensure the detail fetch was made
    const viewCalls = calls.filter((c) => c[1] === 'view');
    expect(viewCalls).toHaveLength(1);
  });

  test('concurrent refresh() calls share the same in-flight promise', async () => {
    await store.load();
    let listCount = 0;
    const runGh = async () => {
      listCount++;
      // simulate some async work
      await new Promise((r) => setTimeout(r, 20));
      return { stdout: '[]', stderr: '' };
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const [r1, r2, r3] = await Promise.all([
      refresher.refresh(),
      refresher.refresh(),
      refresher.refresh(),
    ]);
    // All callers receive the same result
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    // And only one run hit gh (2 repos × 1 call each = 2 list calls)
    expect(listCount).toBe(2);
  });

  test('empty registry → ok with zero repos', async () => {
    writeFileSync(registryPath, JSON.stringify({ version: 1, repos: {} }));
    await store.load();
    const { runGh } = fakeGhFactory({});
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();
    expect(result.ok).toBe(true);
    expect(result.reposTotal).toBe(0);
  });

  test('records truncation warning when gh pr list returns exactly the limit', async () => {
    await store.load();
    const hundredPrs = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i + 1}`,
      url: `https://github.com/grafana/grafana/pull/${i + 1}`,
      state: 'MERGED',
      createdAt: FIX_T_CREATED,
      mergedAt: FIX_T_MERGED,
      closedAt: null,
      updatedAt: FIX_T_MERGED,
    }));
    const { runGh } = fakeGhFactory({
      'grafana/grafana': JSON.stringify(hundredPrs),
      'pr list --repo rust-lang/rust': '[]',
    });
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();
    expect(result.truncated).toContain('grafana/grafana');
  });

  test('populates issueNumber from PR body via the detail fetch', async () => {
    // Regression test for the production verification path: the refresh must
    // extract the linked issue number by parsing "Fixes/Closes/Resolves #NNN"
    // from the PR body returned by `gh pr view --json body`, and patch it
    // onto the closed record so the scout's (repo, issueNumber) secondary-
    // index dedup works in production across all gh CLI versions.
    await store.load();
    const { runGh } = fakeGhFactory({
      'pr list --repo grafana/grafana': JSON.stringify([
        {
          number: 500,
          title: 'First attempt',
          url: 'https://github.com/grafana/grafana/pull/500',
          state: 'CLOSED',
          createdAt: FIX_T_CREATED,
          mergedAt: null,
          closedAt: FIX_T_MERGED,
          updatedAt: FIX_T_MERGED,
        },
      ]),
      'pr list --repo rust-lang/rust': '[]',
      'pr view https://github.com/grafana/grafana/pull/500': JSON.stringify({
        closedAt: FIX_T_MERGED,
        comments: [{ author: { login: 'maintainer' }, body: 'out of scope' }],
        body: '## Summary\n\nFixes #42\n\nRemoves the guard...',
      }),
    });
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();

    // The stored record must now have issueNumber so dedupeScout can find it
    const byIssue = store.findByRepoIssue('grafana/grafana', 42);
    expect(byIssue).toHaveLength(1);
    expect(byIssue[0].prNumber).toBe(500);

    // And the end-to-end dedup decision for a fresh scout on issue 42 must be "demote"
    const decision = store.dedupeScout('grafana/grafana', 42);
    expect(decision.decision).toBe('demote');
    expect(decision.closingComment).toContain('out of scope');
  });

  test('gh error on one repo is recorded but refresh completes for others', async () => {
    await store.load();
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('grafana/grafana')) {
        throw new Error('HTTP 401');
      }
      return { stdout: '[]', stderr: '' };
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].repo).toBe('grafana/grafana');
    expect(result.ok).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Zombie-PR detection (RFC v3.1)
// ----------------------------------------------------------------------------

/**
 * Helper to build a realistic `gh pr list` item in the shape the refresher
 * now expects (including `body`).
 */
function mkListPr(overrides: Partial<{
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  body: string;
}>): Record<string, unknown> {
  return {
    number: 1,
    title: 'Test PR',
    url: 'https://github.com/grafana/grafana/pull/1',
    state: 'OPEN',
    createdAt: FIX_T_CREATED,
    mergedAt: null,
    closedAt: null,
    updatedAt: FIX_T_UPDATED,
    body: '',
    ...overrides,
  };
}

/**
 * Build a single-repo registry for a more compact zombie-detection fixture.
 */
function mkZombieRegistry(dir: string, repo: string): string {
  const path = join(dir, 'oss-repos.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      repos: { [repo]: { status: 'active' } },
    }),
  );
  return path;
}

describe('OssRefresher — zombie-PR detection', () => {
  let tempDir: string;
  let store: OssAttemptStore;
  let registryPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oss-zombie-test-'));
    store = new OssAttemptStore(tempDir);
    registryPath = mkZombieRegistry(tempDir, 'grafana/grafana');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // T-R1: First observation of open PR with Fixes #N → issue is open.
  test('T-R1: populates linkedIssue.state=open on first observation', async () => {
    await store.load();
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([
            mkListPr({ number: 1, body: 'Fixes #10' }),
          ]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        return {
          stdout: JSON.stringify({ state: 'open', closed_at: null, closed_by: null }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();
    const attempt = store.getByRepo('grafana/grafana')[0];
    expect(attempt.linkedIssue).not.toBeNull();
    expect(attempt.linkedIssue?.state).toBe('open');
    expect(attempt.linkedIssue?.number).toBe(10);
    expect(attempt.linkedIssue?.closingPrNumber).toBeNull();
    expect(attempt.linkedIssue?.closedAt).toBeNull();
    expect(attempt.linkedIssue?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.issueChecksPerformed).toBe(1);
    expect(result.issueCheckErrors).toHaveLength(0);
  });

  // T-R2: Closed-by-another-PR (zombie).
  test('T-R2: captures closingPrNumber when closed by different PR', async () => {
    await store.load();
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([mkListPr({ number: 1, body: 'Fixes #10' })]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        return {
          stdout: JSON.stringify({
            state: 'closed',
            closed_at: FIX_T_CLOSED,
            closed_by: { pull_request: { number: 99 } },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();
    const attempt = store.getByRepo('grafana/grafana')[0];
    expect(attempt.linkedIssue?.state).toBe('closed');
    expect(attempt.linkedIssue?.closingPrNumber).toBe(99);
    expect(attempt.linkedIssue?.closedAt).toBe(FIX_T_CLOSED);
  });

  // T-R3: Skip re-fetch when cached closed state matches a current linked number.
  test('T-R3: skips gh api when cached linkedIssue.state=closed matches body number', async () => {
    await store.load();
    // Seed the store with a pr_open record whose linkedIssue is already cached as closed.
    store.upsertFromRefresh({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Zombie',
      state: 'pr_open',
      source: 'refresh_poll',
      at: FIX_T_UPDATED,
    });
    store.attachLinkedIssue('grafana/grafana', 1, {
      number: 10,
      state: 'closed',
      closedAt: FIX_T_CLOSED,
      closingPrNumber: 99,
      verifiedAt: FIX_T_CLOSED,
    });

    const calls: string[] = [];
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      calls.push(key);
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([mkListPr({ number: 1, body: 'Fixes #10' })]),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();
    // No issue-state fetch — cached closed is terminal.
    expect(calls.some((c) => c.includes('api repos/grafana/grafana/issues/'))).toBe(false);
    expect(result.issueChecksPerformed).toBe(0);
  });

  // T-R4: Re-fetch when cached linkedIssue.state === 'open'.
  test('T-R4: re-fetches when cached linkedIssue.state=open', async () => {
    await store.load();
    store.upsertFromRefresh({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'PR',
      state: 'pr_open',
      source: 'refresh_poll',
      at: FIX_T_UPDATED,
    });
    store.attachLinkedIssue('grafana/grafana', 1, {
      number: 10,
      state: 'open',
      closedAt: null,
      closingPrNumber: null,
      verifiedAt: FIX_T_UPDATED,
    });

    let issueCallCount = 0;
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([mkListPr({ number: 1, body: 'Fixes #10' })]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        issueCallCount++;
        return {
          stdout: JSON.stringify({ state: 'open', closed_at: null, closed_by: null }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();
    expect(issueCallCount).toBe(1);
  });

  // T-R5: Preserve linkedIssue across a refresh that only changes PR state fields.
  test('T-R5: preserves linkedIssue across title-only refresh (cached closed)', async () => {
    await store.load();
    store.upsertFromRefresh({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Old Title',
      state: 'pr_open',
      source: 'refresh_poll',
      at: FIX_T_UPDATED,
    });
    store.attachLinkedIssue('grafana/grafana', 1, {
      number: 10,
      state: 'closed',
      closedAt: FIX_T_CLOSED,
      closingPrNumber: 99,
      verifiedAt: FIX_T_CLOSED,
    });

    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([
            mkListPr({ number: 1, title: 'New Title', body: 'Fixes #10' }),
          ]),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();
    const attempt = store.getByRepo('grafana/grafana')[0];
    expect(attempt.prTitle).toBe('New Title');
    expect(attempt.linkedIssue?.state).toBe('closed');
    expect(attempt.linkedIssue?.closingPrNumber).toBe(99);
  });

  // T-R7 (flagship): Replay the litellm #25520 / #25132 / #25263 case.
  test('T-R7: flagship — BerriAI/litellm #25520 ↔ issue #25132 ↔ #25263', async () => {
    const litellmRegistry = mkZombieRegistry(tempDir, 'BerriAI/litellm');
    await store.load();
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo BerriAI/litellm')) {
        return {
          stdout: JSON.stringify([
            {
              number: 25520,
              title: 'fix(together_ai): support reasoning_effort for gpt-oss models',
              url: 'https://github.com/BerriAI/litellm/pull/25520',
              state: 'OPEN',
              createdAt: FIX_T_UPDATED,
              mergedAt: null,
              closedAt: null,
              updatedAt: FIX_T_UPDATED,
              body:
                '## Relevant issues\n\nFixes #25132\n\n## Changes\n\nTogether AI config fix...',
            },
          ]),
          stderr: '',
        };
      }
      if (key.includes('api repos/BerriAI/litellm/issues/25132')) {
        return {
          stdout: JSON.stringify({
            state: 'closed',
            closed_at: FIX_T_CLOSED_LATE,
            closed_by: { pull_request: { number: 25263 } },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({
      store,
      runGh,
      registryPath: litellmRegistry,
    });
    await refresher.refresh();
    const attempt = store.getByRepo('BerriAI/litellm')[0];
    expect(attempt.prNumber).toBe(25520);
    expect(attempt.state).toBe('pr_open');
    expect(attempt.linkedIssue?.number).toBe(25132);
    expect(attempt.linkedIssue?.state).toBe('closed');
    expect(attempt.linkedIssue?.closingPrNumber).toBe(25263);
    expect(attempt.linkedIssue?.closedAt).toBe(FIX_T_CLOSED_LATE);
  });

  // T-R8: Issue-state fetch throws → issueCheckErrors, lastRefreshAt still advances.
  test('T-R8: issue-state throw does not block lastRefreshAt', async () => {
    await store.load();
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([mkListPr({ number: 1, body: 'Fixes #10' })]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        throw new Error('HTTP 503');
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();
    expect(result.errors).toHaveLength(0); // list errors only
    expect(result.issueCheckErrors).toHaveLength(1);
    expect(result.issueCheckErrors[0].prNumber).toBe(1);
    expect(result.issueCheckErrors[0].message).toContain('503');
    // lastRefreshAt SHOULD advance because the LIST succeeded
    expect(store.getLastRefreshAt()).not.toBeNull();
    // And the store's lastRefreshIssueCheckErrors carries the warning
    expect(store.getLastRefreshIssueCheckErrors()).toHaveLength(1);
  });

  // T-R9: Body-parse backfill of issueNumber — only when null.
  test('T-R9: issueNumber is preserved when already set (body-edit safety)', async () => {
    await store.load();
    store.upsertFromRefresh({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'PR',
      state: 'pr_open',
      issueNumber: 42, // already set
      source: 'refresh_poll',
      at: FIX_T_UPDATED,
    });

    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        // Body now references #99, NOT #42. We must NOT overwrite the stored 42.
        return {
          stdout: JSON.stringify([mkListPr({ number: 1, body: 'Fixes #99' })]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/99')) {
        return {
          stdout: JSON.stringify({ state: 'open', closed_at: null, closed_by: null }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();
    const attempt = store.getByRepo('grafana/grafana')[0];
    // issueNumber stays 42 (dedup index stable)
    expect(attempt.issueNumber).toBe(42);
    // linkedIssue reflects the current body (99)
    expect(attempt.linkedIssue?.number).toBe(99);
  });

  // T-R10: fetchLinkedIssueState defensive closed_by shapes — all four.
  test.each([
    ['closed_by: null', { state: 'closed', closed_at: FIX_T_CLOSED, closed_by: null }],
    ['closed_by: {}', { state: 'closed', closed_at: FIX_T_CLOSED, closed_by: {} }],
    [
      'closed_by: { pull_request: null }',
      {
        state: 'closed',
        closed_at: FIX_T_CLOSED,
        closed_by: { pull_request: null },
      },
    ],
    ['closed_by missing entirely', { state: 'closed', closed_at: FIX_T_CLOSED }],
  ])('T-R10: handles %s without crashing (closingPrNumber=null)', async (_label, detail) => {
    await store.load();
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([mkListPr({ number: 1, body: 'Fixes #10' })]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        return { stdout: JSON.stringify(detail), stderr: '' };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();
    const attempt = store.getByRepo('grafana/grafana')[0];
    expect(attempt.linkedIssue?.state).toBe('closed');
    expect(attempt.linkedIssue?.closingPrNumber).toBeNull();
  });

  // T-R11: Multi-issue body — first closed-by-different-PR wins.
  test('T-R11: multi-issue body picks the closed-by-different-PR match', async () => {
    await store.load();
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([
            mkListPr({ number: 1, body: 'Fixes #10, Closes #20' }),
          ]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        return {
          stdout: JSON.stringify({ state: 'open', closed_at: null, closed_by: null }),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/20')) {
        return {
          stdout: JSON.stringify({
            state: 'closed',
            closed_at: FIX_T_CLOSED,
            closed_by: { pull_request: { number: 30 } },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();
    const attempt = store.getByRepo('grafana/grafana')[0];
    expect(attempt.linkedIssue?.number).toBe(20);
    expect(attempt.linkedIssue?.state).toBe('closed');
    expect(attempt.linkedIssue?.closingPrNumber).toBe(30);
  });

  // T-R12: Multi-issue short-circuit — stops at first closed match.
  test('T-R12: multi-issue loop short-circuits on first closed-by-different-PR match', async () => {
    await store.load();
    const calls: string[] = [];
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      calls.push(key);
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([
            // Three linked issues. #10 is already a zombie; we should NOT fetch #20 or #30.
            mkListPr({ number: 1, body: 'Fixes #10, Closes #20, Resolves #30' }),
          ]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        return {
          stdout: JSON.stringify({
            state: 'closed',
            closed_at: FIX_T_CLOSED,
            closed_by: { pull_request: { number: 99 } },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();
    // Only ONE issue-state call was made, despite three linked numbers.
    const issueCalls = calls.filter((c) => c.includes('api repos/grafana/grafana/issues/'));
    expect(issueCalls).toHaveLength(1);
    expect(result.issueChecksPerformed).toBe(1);
  });

  // T-R14: Per-repo save durability — on-disk file contains repo A's updates
  // after repo B's list throws mid-loop.
  test('T-R14: per-repo save persists repo A updates even when repo B list throws', async () => {
    // Two-repo registry for this test.
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        repos: {
          'grafana/grafana': { status: 'active' },
          'rust-lang/rust': { status: 'active' },
        },
      }),
    );
    await store.load();
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([mkListPr({ number: 1, body: 'Fixes #10' })]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        return {
          stdout: JSON.stringify({
            state: 'closed',
            closed_at: FIX_T_CLOSED,
            closed_by: { pull_request: { number: 99 } },
          }),
          stderr: '',
        };
      }
      if (key.includes('pr list --repo rust-lang/rust')) {
        throw new Error('simulated network death on repo B');
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const saveSpy = vi.spyOn(store, 'save');
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();

    // Primary assertion: repo A's linkedIssue update is on disk.
    // This is the REAL F2 durability guarantee — the per-repo `finally` save
    // must have fired for repo A before repo B's failure, and the write must
    // have been atomic (not torn by the B throw).
    const onDisk = JSON.parse(
      readFileSync(join(tempDir, 'oss-attempts.json'), 'utf-8'),
    );
    const grafanaRecord = onDisk.attempts.find(
      (a: { repo: string; prNumber: number }) =>
        a.repo === 'grafana/grafana' && a.prNumber === 1,
    );
    expect(grafanaRecord).not.toBeUndefined();
    expect(grafanaRecord.linkedIssue).not.toBeNull();
    expect(grafanaRecord.linkedIssue.state).toBe('closed');
    expect(grafanaRecord.linkedIssue.number).toBe(10);
    expect(grafanaRecord.linkedIssue.closingPrNumber).toBe(99);
    expect(grafanaRecord.linkedIssue.closedAt).toBe(FIX_T_CLOSED);

    // Secondary assertion: save was called at least 3 times (2 per-repo
    // `finally` + 1 end-of-run). `>= 2` is too weak — it passes even if one
    // of the per-repo saves is missing, which is exactly the regression F2
    // exists to guard against.
    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    // repo B's list error is recorded.
    expect(result.errors.some((e) => e.repo === 'rust-lang/rust')).toBe(true);

    saveSpy.mockRestore();
  });

  // T-R16: Empty-registry early-return preserves prior issueCheckErrors.
  // Regression guard for the fix where the zero-registry branch was clobbering
  // a previously-persisted `lastRefreshIssueCheckErrors` with an empty array.
  test('T-R16: empty registry preserves prior lastRefreshIssueCheckErrors', async () => {
    // Seed the store with prior errors, then run a refresh against an empty registry.
    writeFileSync(
      registryPath,
      JSON.stringify({ version: 1, repos: {} }),
    );
    await store.load();
    store.setLastRefreshIssueCheckErrors([
      { repo: 'grafana/grafana', prNumber: 99, message: 'prior error' },
    ]);
    await store.save();

    const runGh = async () => ({ stdout: '[]', stderr: '' });
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();

    expect(result.reposTotal).toBe(0);
    // The prior error must still be visible via the snapshot.
    expect(store.getLastRefreshIssueCheckErrors()).toEqual([
      { repo: 'grafana/grafana', prNumber: 99, message: 'prior error' },
    ]);
  });

  // T-R17: Budget exhaustion causes `issueChecksSkipped` to tick.
  // Saturates the budget with many fake-repo list calls so the eventual
  // per-PR issue-state check hits the `ghCalls >= GH_CALL_BUDGET` guard and
  // falls into the skip branch.
  test('T-R17: budget exhaustion increments issueChecksSkipped', async () => {
    // 60 fake active repos — `GH_CALL_BUDGET = 60` is exactly 60 list calls.
    // Each list returns an empty array (no PRs), so the only thing consuming
    // budget is the list calls themselves. The 61st repo's PR triggers the
    // per-PR issue-state guard AFTER the budget is already exhausted.
    const repos: Record<string, { status: string }> = {};
    for (let i = 1; i <= 60; i++) {
      repos[`fake-org/repo-${i}`] = { status: 'active' };
    }
    // This repo's PR will be the one trying to hit the issue-state endpoint.
    repos['target/repo'] = { status: 'active' };
    writeFileSync(registryPath, JSON.stringify({ version: 1, repos }));
    await store.load();

    let issueCallCount = 0;
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo target/repo')) {
        return {
          stdout: JSON.stringify([
            mkListPr({
              number: 1,
              url: 'https://github.com/target/repo/pull/1',
              body: 'Fixes #10, Closes #20',
            }),
          ]),
          stderr: '',
        };
      }
      if (key.includes('pr list --repo')) {
        // fake-org/repo-N: empty response consumes 1 budget slot.
        return { stdout: '[]', stderr: '' };
      }
      if (key.includes('api repos/target/repo/issues/')) {
        issueCallCount++;
        return {
          stdout: JSON.stringify({ state: 'open', closed_at: null, closed_by: null }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();

    // The 60 fake repos consume all 60 budget slots on list calls alone.
    // target/repo still gets its list call (always allowed — top-of-loop
    // break was removed), but the per-PR issue-state guard sees
    // `ghCalls >= 60` and skips both linked issues.
    expect(issueCallCount).toBe(0);
    expect(result.issueChecksPerformed).toBe(0);
    expect(result.issueChecksSkipped).toBe(2); // both #10 and #20 skipped
    // And the repo list call for target/repo DID happen (regression guard
    // for the top-of-loop break removal).
    expect(result.reposProcessed).toBe(61);
  });

  // T-R18: All-errored multi-issue case preserves the prior cache.
  // If every linked-issue fetch throws, `checkLinkedIssueState` must return
  // the previous `linkedIssue` unchanged — not overwrite it with null.
  test('T-R18: all-errored multi-issue case preserves prior linkedIssue', async () => {
    await store.load();
    store.upsertFromRefresh({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'PR',
      state: 'pr_open',
      source: 'refresh_poll',
      at: FIX_T_UPDATED,
    });
    // Seed a valid prior open cache for #10.
    store.attachLinkedIssue('grafana/grafana', 1, {
      number: 10,
      state: 'open',
      closedAt: null,
      closingPrNumber: null,
      verifiedAt: FIX_T_CLOSED,
    });

    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([
            mkListPr({ number: 1, body: 'Fixes #10, Closes #20' }),
          ]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/')) {
        throw new Error('HTTP 503 — all flaky');
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    const result = await refresher.refresh();

    // Both issue fetches errored.
    expect(result.issueCheckErrors).toHaveLength(2);

    // The previous `linkedIssue` MUST still be present — we have no fresh
    // signal to overwrite it with, so we preserve the last known state.
    const attempt = store.getByRepo('grafana/grafana')[0];
    expect(attempt.linkedIssue).not.toBeNull();
    expect(attempt.linkedIssue?.number).toBe(10);
    expect(attempt.linkedIssue?.state).toBe('open');
  });

  // T-R15: NFM-6 summary log line format.
  test('T-R15: logs summary line with repos, checks, errors, skipped, stale counts', async () => {
    await store.load();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runGh = async (args: string[]) => {
      const key = args.join(' ');
      if (key.includes('pr list --repo grafana/grafana')) {
        return {
          stdout: JSON.stringify([mkListPr({ number: 1, body: 'Fixes #10' })]),
          stderr: '',
        };
      }
      if (key.includes('api repos/grafana/grafana/issues/10')) {
        return {
          stdout: JSON.stringify({
            state: 'closed',
            closed_at: FIX_T_CLOSED,
            closed_by: { pull_request: { number: 99 } },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh: ${key}`);
    };
    const refresher = new OssRefresher({ store, runGh, registryPath });
    await refresher.refresh();

    const summaryLogs = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.startsWith('[oss-refresh]'));
    expect(summaryLogs).toHaveLength(1);
    const line = summaryLogs[0];
    expect(line).toMatch(/1 repos/);
    expect(line).toMatch(/1 issue checks/);
    expect(line).toMatch(/0 errors/);
    expect(line).toMatch(/0 skipped/);
    expect(line).toMatch(/1 stale/); // 1 zombie found

    logSpy.mockRestore();
  });
});
