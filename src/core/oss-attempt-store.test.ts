import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OssAttemptStore,
  isExternalRepo,
  DEFAULT_OSS_ATTEMPT_RETENTION_MS,
  DEFAULT_CONTRIBUTION_LEDGER_MAX_BYTES,
  DEFAULT_CONTRIBUTION_LEDGER_ROTATED_GENERATIONS,
  readOssAttemptRetentionMsFromEnv,
} from './oss-attempt-store.js';
import type { LedgerEntry } from '../shared/contracts/oss-attempts.js';

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

  describe('pruneTerminalAttempts (bounded oss-attempts store — #2286)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function seedAttemptFile(attempts: unknown[]): void {
      writeFileSync(
        join(tempDir, 'oss-attempts.json'),
        JSON.stringify({
          schemaVersion: OSS_ATTEMPTS_SCHEMA_VERSION,
          attempts,
          lastRefreshAt: null,
        }),
      );
    }

    function terminalAttempt(opts: {
      id: string;
      state: 'merged' | 'closed';
      terminalAt: string;
      withClosing?: boolean;
    }) {
      return {
        id: opts.id,
        repo: 'grafana/grafana',
        issueNumber: null,
        issueUrl: null,
        prNumber: Number(opts.id.split('#')[1]) || 1,
        prUrl: `https://github.com/grafana/grafana/pull/${opts.id.split('#')[1] ?? 1}`,
        prTitle: 'x',
        state: opts.state,
        history: [
          {
            state: opts.state,
            at: opts.terminalAt,
            source: 'refresh_poll',
            note: null,
            url: null,
          },
        ],
        closing: opts.withClosing
          ? {
              closedAt: opts.terminalAt,
              closerLogin: 'maintainer',
              closingComment: 'done',
            }
          : null,
        createdAt: opts.terminalAt,
        updatedAt: opts.terminalAt,
      };
    }

    function activeAttempt(opts: {
      id: string;
      state: 'scouted' | 'pr_open';
      at: string;
    }) {
      return {
        id: opts.id,
        repo: 'grafana/grafana',
        issueNumber: opts.state === 'scouted' ? 99 : null,
        issueUrl: null,
        prNumber: opts.state === 'pr_open' ? 7 : null,
        prUrl: opts.state === 'pr_open' ? 'https://github.com/grafana/grafana/pull/7' : null,
        prTitle: opts.state === 'pr_open' ? 'open' : null,
        state: opts.state,
        history: [
          {
            state: opts.state,
            at: opts.at,
            source: opts.state === 'scouted' ? 'scout_emit' : 'posttool_hook',
            note: null,
            url: null,
          },
        ],
        closing: null,
        createdAt: opts.at,
        updatedAt: opts.at,
      };
    }

    test('drops aged terminal attempts and keeps active + recent terminal', async () => {
      const now = Date.now();
      const aged = new Date(now - 120 * DAY_MS).toISOString();
      const recent = new Date(now - 5 * DAY_MS).toISOString();
      seedAttemptFile([
        terminalAttempt({ id: 'grafana/grafana#1', state: 'merged', terminalAt: aged, withClosing: true }),
        terminalAttempt({ id: 'grafana/grafana#2', state: 'closed', terminalAt: aged }),
        terminalAttempt({ id: 'grafana/grafana#3', state: 'merged', terminalAt: recent }),
        activeAttempt({ id: 'grafana/grafana#issue-99', state: 'scouted', at: aged }),
        activeAttempt({ id: 'grafana/grafana#7', state: 'pr_open', at: aged }),
      ]);

      await store.load();

      const ids = store.getAllAttempts().map((a) => a.id).sort();
      expect(ids).toEqual([
        'grafana/grafana#3',
        'grafana/grafana#7',
        'grafana/grafana#issue-99',
      ]);

      // Durable write from prune-on-load drops the aged terminals.
      const onDisk = JSON.parse(readFileSync(join(tempDir, 'oss-attempts.json'), 'utf-8'));
      expect(onDisk.attempts.map((a: { id: string }) => a.id).sort()).toEqual(ids);
    });

    test('retentionMs=0 prunes every terminal attempt immediately; active preserved', () => {
      // Use a stamp strictly in the past so cutoff=Date.now() does not share
      // the same millisecond as the terminal event (which would keep it).
      const past = new Date(Date.now() - 60_000).toISOString();
      store.upsertPr({
        repo: 'grafana/grafana',
        prNumber: 1,
        prUrl: 'https://github.com/grafana/grafana/pull/1',
        prTitle: 'm',
        state: 'merged',
        at: past,
        source: 'refresh_poll',
      });
      store.upsertPr({
        repo: 'grafana/grafana',
        prNumber: 2,
        prUrl: 'https://github.com/grafana/grafana/pull/2',
        prTitle: 'o',
        state: 'pr_open',
        at: past,
        source: 'posttool_hook',
      });
      store.upsertScouted({
        repo: 'grafana/grafana',
        issueNumber: 42,
        at: past,
      });

      expect(store.pruneTerminalAttempts(0)).toBe(1);
      const remaining = store.getAllAttempts();
      expect(remaining).toHaveLength(2);
      expect(remaining.map((a) => a.state).sort()).toEqual(['pr_open', 'scouted']);
    });

    test('save() compacts aged terminals before writing; no-op prune leaves count unchanged', async () => {
      const now = Date.now();
      const aged = new Date(now - 120 * DAY_MS).toISOString();
      store.upsertPr({
        repo: 'grafana/grafana',
        prNumber: 1,
        prUrl: 'https://github.com/grafana/grafana/pull/1',
        prTitle: 'old merge',
        state: 'merged',
        at: aged,
        source: 'refresh_poll',
      });
      store.attachClosing({
        repo: 'grafana/grafana',
        prNumber: 1,
        closedAt: aged,
        closerLogin: 'bot',
        closingComment: 'merged',
      });
      // Force state terminal with aged stamp (attachClosing bumps updatedAt to now).
      const internal = store.getAttemptsReadonly()[0];
      // Mutate via closed transition already set; prune uses closing.closedAt.
      expect(internal.state).toBe('merged');

      await store.save();
      expect(store.getAllAttempts()).toHaveLength(0);
      const onDisk = JSON.parse(readFileSync(join(tempDir, 'oss-attempts.json'), 'utf-8'));
      expect(onDisk.attempts).toEqual([]);
    });

    test('does not rewrite contribution-ledger.jsonl when pruning', async () => {
      const now = Date.now();
      const aged = new Date(now - 120 * DAY_MS).toISOString();
      const ledgerLine = JSON.stringify({
        timestamp: aged,
        repo: 'grafana/grafana',
        action: 'pr_created',
        prUrl: 'https://github.com/grafana/grafana/pull/9',
      });
      writeFileSync(join(tempDir, 'contribution-ledger.jsonl'), ledgerLine + '\n');
      seedAttemptFile([
        terminalAttempt({
          id: 'grafana/grafana#9',
          state: 'merged',
          terminalAt: aged,
          withClosing: true,
        }),
      ]);

      await store.load();
      expect(store.getAllAttempts()).toHaveLength(0);

      // Ledger bytes untouched — rate-limit authority stays intact.
      expect(readFileSync(join(tempDir, 'contribution-ledger.jsonl'), 'utf-8')).toBe(
        ledgerLine + '\n',
      );

      // Aged ledger entry must not resurrect the pruned attempt as pr_open.
      await store.loadFromLedger();
      expect(store.getAllAttempts()).toHaveLength(0);
      expect(store.getAllLedgerEntries()).toHaveLength(1);
    });

    test('loadFromLedger still ingests recent pr_created entries', async () => {
      const recent = new Date().toISOString();
      writeFileSync(
        join(tempDir, 'contribution-ledger.jsonl'),
        JSON.stringify({
          timestamp: recent,
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: 'https://github.com/grafana/grafana/pull/11',
        }) + '\n',
      );

      await store.load();
      await store.loadFromLedger();
      expect(store.getAllAttempts()).toHaveLength(1);
      expect(store.getAllAttempts()[0].state).toBe('pr_open');
    });

    test('negative retentionMs is clamped to 0', () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      store.upsertPr({
        repo: 'grafana/grafana',
        prNumber: 1,
        prUrl: 'https://github.com/grafana/grafana/pull/1',
        prTitle: 'm',
        state: 'merged',
        at: past,
        source: 'refresh_poll',
      });
      expect(store.pruneTerminalAttempts(-1)).toBe(1);
      expect(store.getAllAttempts()).toHaveLength(0);
    });
  });
});

describe('OssAttemptStore — contribution ledger rotation (#2331)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ledger-rotate-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function ledgerEntry(overrides: Partial<LedgerEntry> & Pick<LedgerEntry, 'action' | 'repo'>): LedgerEntry {
    return {
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      repo: overrides.repo,
      action: overrides.action,
      prUrl: overrides.prUrl,
      command: overrides.command,
      taskId: overrides.taskId,
      blockReason: overrides.blockReason,
    };
  }

  test('defaults export safe rotation knobs', () => {
    expect(DEFAULT_CONTRIBUTION_LEDGER_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(DEFAULT_CONTRIBUTION_LEDGER_ROTATED_GENERATIONS).toBe(2);
  });

  test('appendLedgerEntry rotates when an append would exceed maxBytes', async () => {
    // Small cap so a handful of ~100-byte JSON lines force rotation.
    const store = new OssAttemptStore(tempDir, {
      ledgerMaxBytes: 120,
      ledgerRotatedGenerations: 2,
    });
    const ledgerPath = join(tempDir, 'contribution-ledger.jsonl');

    await store.appendLedgerEntry(
      ledgerEntry({
        repo: 'grafana/grafana',
        action: 'pr_created',
        prUrl: 'https://github.com/grafana/grafana/pull/1',
        command: 'gh pr create -R grafana/grafana',
      }),
    );
    expect(existsSync(ledgerPath)).toBe(true);
    expect(existsSync(`${ledgerPath}.1`)).toBe(false);

    // Second append exceeds the cap → first generation rotates to `.1`.
    await store.appendLedgerEntry(
      ledgerEntry({
        repo: 'grafana/grafana',
        action: 'pr_created',
        prUrl: 'https://github.com/grafana/grafana/pull/2',
        command: 'gh pr create -R grafana/grafana',
      }),
    );
    expect(existsSync(`${ledgerPath}.1`)).toBe(true);
    expect(statSync(ledgerPath).size).toBeLessThanOrEqual(120 + 200);

    // Third append rotates again; with keep=2 we retain `.1` and `.2`.
    await store.appendLedgerEntry(
      ledgerEntry({
        repo: 'rust-lang/rust',
        action: 'pr_created',
        prUrl: 'https://github.com/rust-lang/rust/pull/3',
        command: 'gh pr create -R rust-lang/rust',
      }),
    );
    expect(existsSync(`${ledgerPath}.1`)).toBe(true);
    expect(existsSync(`${ledgerPath}.2`)).toBe(true);
  });

  test('loadFromLedger reads active file plus retained rotated generations', async () => {
    const store = new OssAttemptStore(tempDir, {
      ledgerMaxBytes: 120,
      ledgerRotatedGenerations: 2,
    });

    // Seed three generations via the real append path so load sees rotated files.
    for (const n of [1, 2, 3]) {
      await store.appendLedgerEntry(
        ledgerEntry({
          repo: 'grafana/grafana',
          action: 'pr_created',
          prUrl: `https://github.com/grafana/grafana/pull/${n}`,
          command: 'gh pr create',
        }),
      );
    }

    const reloaded = new OssAttemptStore(tempDir, {
      ledgerMaxBytes: 120,
      ledgerRotatedGenerations: 2,
    });
    await reloaded.load();
    await reloaded.loadFromLedger();

    const entries = reloaded.getAllLedgerEntries();
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const prUrls = entries
      .filter((e) => e.action === 'pr_created')
      .map((e) => e.prUrl)
      .sort();
    expect(prUrls).toEqual([
      'https://github.com/grafana/grafana/pull/1',
      'https://github.com/grafana/grafana/pull/2',
      'https://github.com/grafana/grafana/pull/3',
    ]);
    // Rate-limit-facing attempts ingest still works across generations.
    expect(reloaded.getAllAttempts()).toHaveLength(3);
  });

  test('drops generations beyond the keep count', async () => {
    const store = new OssAttemptStore(tempDir, {
      ledgerMaxBytes: 80,
      ledgerRotatedGenerations: 1,
    });
    const ledgerPath = join(tempDir, 'contribution-ledger.jsonl');

    for (const n of [1, 2, 3, 4]) {
      await store.appendLedgerEntry(
        ledgerEntry({
          repo: 'grafana/grafana',
          action: 'slot_reset',
          command: `reset-${n}-${'x'.repeat(40)}`,
        }),
      );
    }

    expect(existsSync(`${ledgerPath}.1`)).toBe(true);
    expect(existsSync(`${ledgerPath}.2`)).toBe(false);
  });

  test('still loads legacy pretty single-file ledgers without rotation artifacts', async () => {
    const today = new Date().toISOString();
    writeFileSync(
      join(tempDir, 'contribution-ledger.jsonl'),
      JSON.stringify({
        timestamp: today,
        repo: 'grafana/grafana',
        action: 'pr_created',
        prUrl: 'https://github.com/grafana/grafana/pull/99',
      }) + '\n',
    );

    const store = new OssAttemptStore(tempDir);
    await store.load();
    await store.loadFromLedger();
    expect(store.getAllAttempts()).toHaveLength(1);
    expect(store.getAllLedgerEntries()).toHaveLength(1);
  });
});

describe('readOssAttemptRetentionMsFromEnv', () => {
  test('defaults to 90 days', () => {
    expect(DEFAULT_OSS_ATTEMPT_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(readOssAttemptRetentionMsFromEnv({})).toBe(DEFAULT_OSS_ATTEMPT_RETENTION_MS);
  });

  test('honours 0 and positive overrides; rejects blank/negative/NaN', () => {
    expect(readOssAttemptRetentionMsFromEnv({ KOOKR_OSS_ATTEMPT_RETENTION_MS: '0' })).toBe(0);
    expect(readOssAttemptRetentionMsFromEnv({ KOOKR_OSS_ATTEMPT_RETENTION_MS: '1000' })).toBe(1000);
    expect(readOssAttemptRetentionMsFromEnv({ KOOKR_OSS_ATTEMPT_RETENTION_MS: '' })).toBe(
      DEFAULT_OSS_ATTEMPT_RETENTION_MS,
    );
    expect(readOssAttemptRetentionMsFromEnv({ KOOKR_OSS_ATTEMPT_RETENTION_MS: '-5' })).toBe(
      DEFAULT_OSS_ATTEMPT_RETENTION_MS,
    );
    expect(readOssAttemptRetentionMsFromEnv({ KOOKR_OSS_ATTEMPT_RETENTION_MS: 'nope' })).toBe(
      DEFAULT_OSS_ATTEMPT_RETENTION_MS,
    );
  });
});
