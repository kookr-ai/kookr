import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OssAttemptStore,
  isExternalRepo,
} from './oss-attempt-store.js';

// Mirrors the internal constant in oss-attempt-store.ts. Kept local so the
// schema version is not part of the module's public API — tests pin the
// on-disk shape, not a re-exported constant.
const OSS_ATTEMPTS_SCHEMA_VERSION = 1;

describe('isExternalRepo', () => {
  test('rejects own-namespace repos by default', () => {
    expect(isExternalRepo('kookr-ai/kookr')).toBe(false);
    expect(isExternalRepo('JEANIBARZ/kookr')).toBe(false);
  });
  test('accepts external repos', () => {
    expect(isExternalRepo('grafana/grafana')).toBe(true);
    expect(isExternalRepo('rust-lang/rust')).toBe(true);
  });
  test('honors custom own-namespace list', () => {
    expect(isExternalRepo('acme/foo', ['acme'])).toBe(false);
    expect(isExternalRepo('other/foo', ['acme'])).toBe(true);
  });
});

describe('OssAttemptStore', () => {
  let tempDir: string;
  let store: OssAttemptStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oss-attempt-test-'));
    store = new OssAttemptStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('starts empty', async () => {
    await store.load();
    expect(store.getAllAttempts()).toEqual([]);
    expect(store.getLastRefreshAt()).toBeNull();
  });

  test('persists schemaVersion + roundtrip', async () => {
    await store.load();
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
      source: 'posttool_hook',
    });
    store.setLastRefreshAt('2026-04-10T00:00:00Z');
    await store.save();

    const raw = JSON.parse(readFileSync(join(tempDir, 'oss-attempts.json'), 'utf-8'));
    expect(raw.schemaVersion).toBe(OSS_ATTEMPTS_SCHEMA_VERSION);
    expect(raw.attempts).toHaveLength(1);
    expect(raw.lastRefreshAt).toBe('2026-04-10T00:00:00Z');

    const store2 = new OssAttemptStore(tempDir);
    await store2.load();
    expect(store2.getAllAttempts()).toHaveLength(1);
    expect(store2.getLastRefreshAt()).toBe('2026-04-10T00:00:00Z');
  });

  test('falls back to empty store on unknown schemaVersion', async () => {
    writeFileSync(
      join(tempDir, 'oss-attempts.json'),
      JSON.stringify({ schemaVersion: 999, attempts: [{}], lastRefreshAt: null }),
    );
    await store.load();
    expect(store.getAllAttempts()).toEqual([]);
  });

  test('skips invalid records with a warning', async () => {
    writeFileSync(
      join(tempDir, 'oss-attempts.json'),
      JSON.stringify({
        schemaVersion: OSS_ATTEMPTS_SCHEMA_VERSION,
        attempts: [
          { id: 'bad', repo: 'grafana/grafana', state: 'nope', history: [] },
          {
            id: 'good',
            repo: 'grafana/grafana',
            state: 'pr_open',
            history: [],
            issueNumber: null,
            issueUrl: null,
            prNumber: 1,
            prUrl: 'https://x',
            prTitle: 'ok',
            closing: null,
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
          },
        ],
        lastRefreshAt: null,
      }),
    );
    await store.load();
    expect(store.getAllAttempts()).toHaveLength(1);
    expect(store.getAllAttempts()[0].id).toBe('good');
  });

  test('rejects own-namespace repos on upsertPr', () => {
    const result = store.upsertPr({
      repo: 'kookr-ai/kookr',
      prNumber: 1,
      prUrl: 'https://github.com/kookr-ai/kookr/pull/1',
      prTitle: 'x',
      source: 'posttool_hook',
    });
    expect(result).toBeNull();
    expect(store.getAllAttempts()).toHaveLength(0);
  });

  test('rejects own-namespace repos on upsertScouted', () => {
    const result = store.upsertScouted({
      repo: 'kookr-ai/kookr',
      issueNumber: 123,
    });
    expect(result).toBeNull();
  });

  test('upsertPr creates + updates with latest-observed state', () => {
    const a = store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
      source: 'posttool_hook',
    });
    expect(a?.state).toBe('pr_open');
    expect(a?.history).toHaveLength(1);

    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
      state: 'merged',
      source: 'refresh_poll',
    });
    const updated = store.getByRepo('grafana/grafana')[0];
    expect(updated.state).toBe('merged');
    expect(updated.history).toHaveLength(2);
  });

  test('upsertPr tolerates reopen: closed → pr_open clears closing', () => {
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
      source: 'posttool_hook',
    });
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
      state: 'closed',
      source: 'refresh_poll',
    });
    store.attachClosing({
      repo: 'grafana/grafana',
      prNumber: 1,
      closedAt: '2026-04-10T12:00:00Z',
      closerLogin: 'maintainer',
      closingComment: 'out of scope',
    });
    expect(store.getByRepo('grafana/grafana')[0].closing).not.toBeNull();

    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
      state: 'pr_open',
      source: 'refresh_poll',
    });
    const record = store.getByRepo('grafana/grafana')[0];
    expect(record.state).toBe('pr_open');
    expect(record.closing).toBeNull();
    // History preserves the closing observation
    expect(record.history.some((h) => h.state === 'closed')).toBe(true);
  });

  test('upsertPr handles reopen → merged (non-monotonic)', () => {
    const pr = {
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
    };
    store.upsertPr({ ...pr, source: 'posttool_hook' });
    store.upsertPr({ ...pr, state: 'closed', source: 'refresh_poll' });
    store.upsertPr({ ...pr, state: 'pr_open', source: 'refresh_poll' });
    store.upsertPr({ ...pr, state: 'merged', source: 'refresh_poll' });
    const record = store.getByRepo('grafana/grafana')[0];
    expect(record.state).toBe('merged');
    expect(record.history.map((h) => h.state)).toEqual([
      'pr_open',
      'closed',
      'pr_open',
      'merged',
    ]);
  });

  test('upsertScouted creates issue-keyed record', () => {
    const a = store.upsertScouted({
      repo: 'grafana/grafana',
      issueNumber: 42,
      issueUrl: 'https://github.com/grafana/grafana/issues/42',
    });
    expect(a?.id).toBe('grafana/grafana#issue-42');
    expect(a?.state).toBe('scouted');
  });

  test('scouted + separate PR record coexist for same issue (NFM-1 fix)', () => {
    store.upsertScouted({
      repo: 'grafana/grafana',
      issueNumber: 42,
    });
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 500,
      prUrl: 'https://github.com/grafana/grafana/pull/500',
      prTitle: 'Fix issue 42',
      issueNumber: 42,
      source: 'posttool_hook',
    });
    const byIssue = store.findByRepoIssue('grafana/grafana', 42);
    expect(byIssue).toHaveLength(2);
    expect(byIssue.map((a) => a.id).sort()).toEqual([
      'grafana/grafana#500',
      'grafana/grafana#issue-42',
    ]);
  });

  test('dedupeScout: allow when no records', () => {
    expect(store.dedupeScout('grafana/grafana', 999)).toEqual({ decision: 'allow' });
  });

  test('dedupeScout: allow when only scouted records exist', () => {
    store.upsertScouted({ repo: 'grafana/grafana', issueNumber: 42 });
    expect(store.dedupeScout('grafana/grafana', 42).decision).toBe('allow');
  });

  test('dedupeScout: exclude when pr_open exists', () => {
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 500,
      prUrl: 'https://github.com/grafana/grafana/pull/500',
      prTitle: 'Fix',
      issueNumber: 42,
      source: 'posttool_hook',
    });
    expect(store.dedupeScout('grafana/grafana', 42)).toMatchObject({
      decision: 'exclude',
      reason: 'pr_open',
      prNumber: 500,
    });
  });

  test('dedupeScout: exclude when merged exists', () => {
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 500,
      prUrl: 'https://github.com/grafana/grafana/pull/500',
      prTitle: 'Fix',
      issueNumber: 42,
      state: 'merged',
      source: 'refresh_poll',
    });
    expect(store.dedupeScout('grafana/grafana', 42).decision).toBe('exclude');
  });

  test('dedupeScout: NFM-1 — historical closed PR keyed by PR number still blocks scouting by issue number', () => {
    // Scenario: previous closed PR #500 for issue 42 — keyed by `grafana/grafana#500`.
    // A naive id-based lookup (grafana/grafana#issue-42) would miss it.
    // The secondary index on (repo, issueNumber) must find it and demote the candidate.
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 500,
      prUrl: 'https://github.com/grafana/grafana/pull/500',
      prTitle: 'Fix',
      issueNumber: 42,
      state: 'closed',
      source: 'refresh_poll',
    });
    store.attachClosing({
      repo: 'grafana/grafana',
      prNumber: 500,
      closedAt: '2026-04-01T00:00:00Z',
      closerLogin: 'maintainer',
      closingComment: 'duplicate of #123',
    });
    const result = store.dedupeScout('grafana/grafana', 42);
    expect(result.decision).toBe('demote');
    expect(result.closingComment).toContain('duplicate');
  });

  test('dedupeScout: a later pr_open record for the same issue wins over an older closed one', () => {
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 500,
      prUrl: 'https://github.com/grafana/grafana/pull/500',
      prTitle: 'First attempt',
      issueNumber: 42,
      state: 'closed',
      at: '2026-01-01T00:00:00Z',
      source: 'refresh_poll',
    });
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 600,
      prUrl: 'https://github.com/grafana/grafana/pull/600',
      prTitle: 'Second attempt',
      issueNumber: 42,
      state: 'pr_open',
      at: '2026-04-01T00:00:00Z',
      source: 'refresh_poll',
    });
    const result = store.dedupeScout('grafana/grafana', 42);
    expect(result.decision).toBe('exclude');
    expect(result.prNumber).toBe(600);
  });

  test('attachClosing truncates long comments to 500 chars', () => {
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
      state: 'closed',
      source: 'refresh_poll',
    });
    store.attachClosing({
      repo: 'grafana/grafana',
      prNumber: 1,
      closedAt: '2026-04-10T00:00:00Z',
      closerLogin: 'maintainer',
      closingComment: 'x'.repeat(1000),
    });
    const record = store.getByRepo('grafana/grafana')[0];
    expect(record.closing?.closingComment.length).toBe(500);
  });

  test('concurrent save() calls are serialized without corruption', async () => {
    await store.load();
    // Queue up 10 concurrent mutations + saves
    const work = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(async () => {
        store.upsertPr({
          repo: 'grafana/grafana',
          prNumber: i + 1,
          prUrl: `https://github.com/grafana/grafana/pull/${i + 1}`,
          prTitle: `PR ${i + 1}`,
          source: 'posttool_hook',
        });
        await store.save();
      }),
    );
    await Promise.all(work);
    expect(store.getAllAttempts()).toHaveLength(10);

    // File on disk should parse cleanly and contain all 10
    const raw = JSON.parse(readFileSync(join(tempDir, 'oss-attempts.json'), 'utf-8'));
    expect(raw.attempts).toHaveLength(10);
  });
});

// ----------------------------------------------------------------------------
// Zombie-PR detection (RFC v3.1): linkedIssue field + attachLinkedIssue
// ----------------------------------------------------------------------------

describe('OssAttemptStore — linkedIssue support', () => {
  let tempDir: string;
  let store: OssAttemptStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oss-linked-issue-test-'));
    store = new OssAttemptStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // T-S1: Load a file without linkedIssue field → records restored with undefined linkedIssue.
  test('T-S1: loads a pre-feature file with no linkedIssue field', async () => {
    writeFileSync(
      join(tempDir, 'oss-attempts.json'),
      JSON.stringify({
        schemaVersion: OSS_ATTEMPTS_SCHEMA_VERSION,
        attempts: [
          {
            id: 'grafana/grafana#1',
            repo: 'grafana/grafana',
            state: 'pr_open',
            history: [],
            issueNumber: null,
            issueUrl: null,
            prNumber: 1,
            prUrl: 'https://x',
            prTitle: 'PR',
            closing: null,
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
            // No linkedIssue field — legacy snapshot.
          },
        ],
        lastRefreshAt: null,
      }),
    );
    await store.load();
    const attempts = store.getAllAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].linkedIssue).toBeUndefined();
  });

  // T-S2: attachLinkedIssue writes the field and bumps updatedAt. Missing-id is a no-op.
  test('T-S2: attachLinkedIssue sets the field and bumps updatedAt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T00:00:00Z'));
    try {
      const created = store.upsertPr({
        repo: 'grafana/grafana',
        prNumber: 1,
        prUrl: 'https://github.com/grafana/grafana/pull/1',
        prTitle: 'PR',
        source: 'posttool_hook',
      });
      expect(created).not.toBeNull();
      expect(created!.updatedAt).toBe('2026-04-10T00:00:00.000Z');

      // Advance the clock deterministically.
      vi.setSystemTime(new Date('2026-04-10T01:00:00Z'));

      store.attachLinkedIssue('grafana/grafana', 1, {
        number: 10,
        state: 'closed',
        closedAt: '2026-04-12T00:00:00Z',
        closingPrNumber: 99,
        verifiedAt: '2026-04-12T00:00:00Z',
      });

      const updated = store.getByRepo('grafana/grafana')[0];
      expect(updated.linkedIssue).not.toBeNull();
      expect(updated.linkedIssue?.number).toBe(10);
      expect(updated.linkedIssue?.state).toBe('closed');
      expect(updated.linkedIssue?.closingPrNumber).toBe(99);
      expect(updated.linkedIssue?.closedAt).toBe('2026-04-12T00:00:00Z');
      expect(updated.updatedAt).toBe('2026-04-10T01:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  test('T-S2b: attachLinkedIssue on a missing record is a silent no-op', () => {
    // No records in the store — nothing to attach to.
    expect(() =>
      store.attachLinkedIssue('grafana/grafana', 999, {
        number: 10,
        state: 'open',
        closedAt: null,
        closingPrNumber: null,
        verifiedAt: '2026-04-12T00:00:00Z',
      }),
    ).not.toThrow();
    expect(store.getAllAttempts()).toHaveLength(0);
  });

  // T-S3: upsertFromRefresh preserves existing linkedIssue across pr-state-only updates.
  test('T-S3: upsertFromRefresh preserves linkedIssue across title-only refresh', () => {
    store.upsertFromRefresh({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Old',
      state: 'pr_open',
      source: 'refresh_poll',
      at: '2026-04-10T00:00:00Z',
    });
    store.attachLinkedIssue('grafana/grafana', 1, {
      number: 10,
      state: 'closed',
      closedAt: '2026-04-12T00:00:00Z',
      closingPrNumber: 99,
      verifiedAt: '2026-04-12T00:00:00Z',
    });

    // Now refresh with a new title — linkedIssue must survive.
    store.upsertFromRefresh({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'New',
      state: 'pr_open',
      source: 'refresh_poll',
      at: '2026-04-13T00:00:00Z',
    });

    const record = store.getByRepo('grafana/grafana')[0];
    expect(record.prTitle).toBe('New');
    expect(record.linkedIssue?.state).toBe('closed');
    expect(record.linkedIssue?.closingPrNumber).toBe(99);
  });

  // T-S4: upsertPr never sets linkedIssue.
  test('T-S4: upsertPr does not set linkedIssue', () => {
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'PR',
      source: 'posttool_hook',
    });
    const record = store.getByRepo('grafana/grafana')[0];
    expect(record.linkedIssue).toBeUndefined();
  });

  // T-S5: isValidAttempt tolerates records with linkedIssue null, object, or absent.
  test('T-S5: loader accepts linkedIssue: null, {...}, and absent', async () => {
    writeFileSync(
      join(tempDir, 'oss-attempts.json'),
      JSON.stringify({
        schemaVersion: OSS_ATTEMPTS_SCHEMA_VERSION,
        attempts: [
          // Absent
          {
            id: 'grafana/grafana#1',
            repo: 'grafana/grafana',
            state: 'pr_open',
            history: [],
            issueNumber: null,
            issueUrl: null,
            prNumber: 1,
            prUrl: 'https://x',
            prTitle: '1',
            closing: null,
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
          },
          // null
          {
            id: 'grafana/grafana#2',
            repo: 'grafana/grafana',
            state: 'pr_open',
            history: [],
            issueNumber: null,
            issueUrl: null,
            prNumber: 2,
            prUrl: 'https://x',
            prTitle: '2',
            closing: null,
            linkedIssue: null,
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
          },
          // full object
          {
            id: 'grafana/grafana#3',
            repo: 'grafana/grafana',
            state: 'pr_open',
            history: [],
            issueNumber: null,
            issueUrl: null,
            prNumber: 3,
            prUrl: 'https://x',
            prTitle: '3',
            closing: null,
            linkedIssue: {
              number: 42,
              state: 'closed',
              closedAt: '2026-04-12T00:00:00Z',
              closingPrNumber: 99,
              verifiedAt: '2026-04-12T00:00:00Z',
            },
            createdAt: '2026-04-10T00:00:00Z',
            updatedAt: '2026-04-10T00:00:00Z',
          },
        ],
        lastRefreshAt: null,
      }),
    );
    await store.load();
    const attempts = store.getAllAttempts();
    expect(attempts).toHaveLength(3);
    const byPrNumber = new Map(attempts.map((a) => [a.prNumber, a]));
    expect(byPrNumber.get(1)?.linkedIssue).toBeUndefined();
    expect(byPrNumber.get(2)?.linkedIssue).toBeNull();
    expect(byPrNumber.get(3)?.linkedIssue?.number).toBe(42);
  });

  // T-S6: Deep-clone regression guard — held reference doesn't observe mutation.
  test('T-S6: snapshot returns a deep clone (torn-read guard)', () => {
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'PR',
      source: 'posttool_hook',
    });

    // Hold a reference to the first attempt BEFORE mutating.
    const heldRef = store.getAllAttempts()[0];
    expect(heldRef.linkedIssue).toBeUndefined();

    // Now mutate via attachLinkedIssue — this would torn-read a shallow copy.
    store.attachLinkedIssue('grafana/grafana', 1, {
      number: 10,
      state: 'closed',
      closedAt: '2026-04-12T00:00:00Z',
      closingPrNumber: 99,
      verifiedAt: '2026-04-12T00:00:00Z',
    });

    // The held reference MUST be unchanged (proves deep clone).
    expect(heldRef.linkedIssue).toBeUndefined();

    // But a fresh read DOES see the update.
    const fresh = store.getAllAttempts()[0];
    expect(fresh.linkedIssue?.number).toBe(10);
  });

  // Extra: setLastRefreshIssueCheckErrors round-trips via save/load.
  test('T-S7: lastRefreshIssueCheckErrors persists through save and reload', async () => {
    await store.load();
    store.setLastRefreshIssueCheckErrors([
      { repo: 'grafana/grafana', prNumber: 1, message: 'HTTP 503' },
      { repo: 'rust-lang/rust', prNumber: 2, message: 'HTTP 429' },
    ]);
    await store.save();

    const store2 = new OssAttemptStore(tempDir);
    await store2.load();
    expect(store2.getLastRefreshIssueCheckErrors()).toEqual([
      { repo: 'grafana/grafana', prNumber: 1, message: 'HTTP 503' },
      { repo: 'rust-lang/rust', prNumber: 2, message: 'HTTP 429' },
    ]);
    expect(store2.getLastRefreshIssueCheckErrors()).toHaveLength(2);
  });
});

describe('OssAttemptStore — ledger ingestion', () => {
  let tempDir: string;
  let store: OssAttemptStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ledger-ingest-test-'));
    store = new OssAttemptStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('ingests pr_created entries into attempts', async () => {
    const today = new Date().toISOString();
    const ledger = [
      JSON.stringify({
        timestamp: today,
        repo: 'grafana/grafana',
        action: 'pr_created',
        prUrl: 'https://github.com/grafana/grafana/pull/42',
        command: 'gh pr create',
      }),
      JSON.stringify({
        timestamp: today,
        repo: 'rust-lang/rust',
        action: 'pr_created',
        prUrl: 'https://github.com/rust-lang/rust/pull/77',
        command: 'gh pr create -R rust-lang/rust',
      }),
    ].join('\n');
    writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);

    await store.load();
    await store.loadFromLedger();

    const attempts = store.getAllAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.state === 'pr_open')).toBe(true);
    expect(attempts.map((a) => a.repo).sort()).toEqual(['grafana/grafana', 'rust-lang/rust']);
  });

  test('filters out own-namespace pr_created entries', async () => {
    const today = new Date().toISOString();
    writeFileSync(
      join(tempDir, 'contribution-ledger.jsonl'),
      JSON.stringify({
        timestamp: today,
        repo: 'kookr-ai/kookr',
        action: 'pr_created',
        prUrl: 'https://github.com/kookr-ai/kookr/pull/300',
      }),
    );

    await store.load();
    await store.loadFromLedger();

    expect(store.getAllAttempts()).toHaveLength(0);
  });

  test('skips pr_created entries without a prUrl', async () => {
    const today = new Date().toISOString();
    writeFileSync(
      join(tempDir, 'contribution-ledger.jsonl'),
      JSON.stringify({ timestamp: today, repo: 'grafana/grafana', action: 'pr_created' }),
    );

    await store.load();
    await store.loadFromLedger();

    expect(store.getAllAttempts()).toHaveLength(0);
  });

  test('is idempotent across repeated loadFromLedger calls', async () => {
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
    await store.loadFromLedger();

    expect(store.getAllAttempts()).toHaveLength(1);
  });

  test('handles malformed lines gracefully', async () => {
    const today = new Date().toISOString();
    const ledger = [
      'not valid json',
      JSON.stringify({
        timestamp: today,
        repo: 'grafana/grafana',
        action: 'pr_created',
        prUrl: 'https://github.com/grafana/grafana/pull/1',
      }),
      '{"incomplete":',
    ].join('\n');
    writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledger);

    await store.load();
    await store.loadFromLedger();

    expect(store.getAllAttempts()).toHaveLength(1);
  });

  test('is a no-op when the ledger file is missing', async () => {
    await store.load();
    await store.loadFromLedger();
    expect(store.getAllAttempts()).toEqual([]);
  });

  test('carries originating taskId onto the attempt on first ingest', async () => {
    const today = new Date().toISOString();
    writeFileSync(
      join(tempDir, 'contribution-ledger.jsonl'),
      JSON.stringify({
        timestamp: today,
        repo: 'grafana/grafana',
        action: 'pr_created',
        prUrl: 'https://github.com/grafana/grafana/pull/55',
        taskId: 'task-alpha',
      }),
    );

    await store.load();
    await store.loadFromLedger();

    const attempt = store.getAllAttempts()[0];
    expect(attempt.taskId).toBe('task-alpha');
  });
});
