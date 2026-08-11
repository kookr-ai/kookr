import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  ViewerGrantStore,
  readGrantRetentionMsFromEnv,
  DEFAULT_GRANT_RETENTION_MS,
} from './viewer-grants.js';

describe('ViewerGrantStore', () => {
  let tempDir: string;
  let store: ViewerGrantStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'viewer-grants-test-'));
    store = new ViewerGrantStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('starts empty', async () => {
    await store.load();
    expect(store.list()).toEqual([]);
  });

  test('create returns a raw token once and persists only its hash', async () => {
    await store.load();
    const { grant, token } = await store.create({ label: 'phone', scope: { kind: 'all' } });

    // Raw token is a 32-byte hex string and is returned exactly here.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // The summary never carries the hash.
    expect(grant).not.toHaveProperty('tokenHash');
    expect(grant.label).toBe('phone');
    expect(grant.scope).toEqual({ kind: 'all' });
    // createdAt is a real, recent ISO-8601 timestamp (not a placeholder).
    const createdMs = Date.parse(grant.createdAt);
    expect(Number.isNaN(createdMs)).toBe(false);
    expect(Math.abs(Date.now() - createdMs)).toBeLessThan(10_000);

    // The on-disk file stores the sha-256 hash, never the raw token.
    const onDisk = readFileSync(join(tempDir, 'share-grants.json'), 'utf-8');
    expect(onDisk).not.toContain(token);
    const expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(onDisk).toContain(expectedHash);
  });

  test('persists share-grants.json with owner-only mode 0o600', async () => {
    await store.load();
    await store.create({ label: 'phone', scope: { kind: 'all' } });

    const grantsPath = join(tempDir, 'share-grants.json');
    const modeAfterCreate = statSync(grantsPath).mode & 0o777;
    expect(modeAfterCreate).toBe(0o600);

    // Re-write after a world-readable seed must still land at 0o600 (rename
    // preserves the temp file’s mode rather than the prior destination mode).
    chmodSync(grantsPath, 0o644);
    expect(statSync(grantsPath).mode & 0o777).toBe(0o644);

    const listed = store.list();
    expect(listed).toHaveLength(1);
    await store.revoke(listed[0]!.id);

    expect(statSync(grantsPath).mode & 0o777).toBe(0o600);
  });

  test('resolve matches a valid token by hash', async () => {
    await store.load();
    const { grant, token } = await store.create({
      label: 'tablet',
      scope: { kind: 'projects', projectIds: ['p1'] },
    });

    const res = store.resolve(token);
    expect(res).toEqual({ kind: 'valid', grantId: grant.id, scope: { kind: 'projects', projectIds: ['p1'] } });
  });

  test('resolve reports not-found for an unknown token', async () => {
    await store.load();
    await store.create({ label: 'x', scope: { kind: 'all' } });
    expect(store.resolve('deadbeef'.repeat(8))).toEqual({ kind: 'not-found' });
  });

  test('revoked grants do not resolve', async () => {
    await store.load();
    const { grant, token } = await store.create({ label: 'laptop', scope: { kind: 'all' } });

    expect(await store.revoke(grant.id)).toBe(true);
    expect(store.resolve(token)).toEqual({ kind: 'revoked', grantId: grant.id });
  });

  test('expired grants do not resolve', async () => {
    await store.load();
    const past = new Date(Date.now() - 60_000).toISOString();
    const { grant, token } = await store.create({ label: 'temp', scope: { kind: 'all' }, expiresAt: past });

    expect(store.resolve(token)).toEqual({ kind: 'expired', grantId: grant.id });
  });

  test('a future expiry still resolves as valid (with its own scope)', async () => {
    await store.load();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const { grant, token } = await store.create({
      label: 'temp',
      scope: { kind: 'projects', projectIds: ['future-p1'] },
      expiresAt: future,
    });

    expect(store.resolve(token)).toEqual({
      kind: 'valid',
      grantId: grant.id,
      scope: { kind: 'projects', projectIds: ['future-p1'] },
    });
  });

  test('revoke is idempotent and false for unknown id', async () => {
    await store.load();
    const { grant } = await store.create({ label: 'x', scope: { kind: 'all' } });

    expect(await store.revoke(grant.id)).toBe(true);
    const firstRevokedAt = store.list().find((g) => g.id === grant.id)?.revokedAt;
    expect(firstRevokedAt).toEqual(expect.any(String));
    // Re-revoking keeps the original timestamp.
    expect(await store.revoke(grant.id)).toBe(true);
    expect(store.list().find((g) => g.id === grant.id)?.revokedAt).toBe(firstRevokedAt);
    // Unknown id.
    expect(await store.revoke('nope')).toBe(false);
  });

  test('scope is canonicalized (sorted + deduped) on create', async () => {
    await store.load();
    const { grant } = await store.create({
      label: 'multi',
      scope: { kind: 'projects', projectIds: ['b', 'a', 'b'] },
    });
    expect(grant.scope).toEqual({ kind: 'projects', projectIds: ['a', 'b'] });
  });

  test('grants survive a reload from disk', async () => {
    await store.load();
    const { grant, token } = await store.create({ label: 'persist', scope: { kind: 'all' } });

    const reopened = new ViewerGrantStore(tempDir);
    await reopened.load();
    expect(reopened.list().map((g) => g.id)).toEqual([grant.id]);
    expect(reopened.resolve(token)).toEqual({ kind: 'valid', grantId: grant.id, scope: { kind: 'all' } });
  });

  test('invalid grant records are skipped on load', async () => {
    const iso = new Date().toISOString();
    writeFileSync(
      join(tempDir, 'share-grants.json'),
      JSON.stringify({
        schemaVersion: 1,
        grants: [
          { id: 'bad-no-hash', label: 'x', scope: { kind: 'all' }, createdAt: iso },
          { id: 'bad-empty-revoked', tokenHash: 'a'.repeat(64), label: 'x', scope: { kind: 'all' }, createdAt: iso, revokedAt: '' },
          { id: 'bad-unparseable-expiry', tokenHash: 'b'.repeat(64), label: 'x', scope: { kind: 'all' }, createdAt: iso, expiresAt: 'whenever' },
          { id: 'good', tokenHash: 'c'.repeat(64), label: 'ok', scope: { kind: 'all' }, createdAt: iso },
        ],
      }),
    );
    await store.load();
    expect(store.list().map((g) => g.id)).toEqual(['good']);
  });

  test('unknown schemaVersion falls back to empty', async () => {
    const iso = new Date().toISOString();
    writeFileSync(
      join(tempDir, 'share-grants.json'),
      JSON.stringify({ schemaVersion: 999, grants: [{ id: 'x', tokenHash: 'a'.repeat(64), label: 'l', scope: { kind: 'all' }, createdAt: iso }] }),
    );
    await store.load();
    expect(store.list()).toEqual([]);
  });

  test('a top-level-null / non-object file degrades to empty (no throw)', async () => {
    writeFileSync(join(tempDir, 'share-grants.json'), 'null');
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);

    writeFileSync(join(tempDir, 'share-grants.json'), '42');
    await store.load();
    expect(store.list()).toEqual([]);
  });

  test('corrupt file is quarantined and fails closed to empty grants', async () => {
    const filePath = join(tempDir, 'share-grants.json');
    const corruptContents = '{"schemaVersion":1,"grants":';
    writeFileSync(filePath, corruptContents);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(store.load()).resolves.toBeUndefined();

    expect(store.list()).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
    const quarantined = readdirSync(tempDir).filter((entry) => entry.startsWith('share-grants.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(tempDir, quarantined[0]), 'utf-8')).toBe(corruptContents);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[viewer-grants] Corrupt JSON file'),
      expect.any(SyntaxError),
    );
  });

  test('a non-array grants field degrades to empty', async () => {
    writeFileSync(
      join(tempDir, 'share-grants.json'),
      JSON.stringify({ schemaVersion: 1, grants: { not: 'an array' } }),
    );
    await store.load();
    expect(store.list()).toEqual([]);
  });

  test('resolve("") is not-found (does not throw or match)', async () => {
    await store.load();
    await store.create({ label: 'x', scope: { kind: 'all' } });
    expect(store.resolve('')).toEqual({ kind: 'not-found' });
  });

  test('resolve does not short-circuit on the first matching grant', async () => {
    // Guards the constant-time no-early-break property: revoke the FIRST grant,
    // then present the SECOND token. An early break that returns on the first
    // match would mis-handle ordering; this pins that the correct grant resolves.
    await store.load();
    const first = await store.create({ label: 'first', scope: { kind: 'all' } });
    const second = await store.create({ label: 'second', scope: { kind: 'all' } });
    await store.revoke(first.grant.id);

    expect(store.resolve(second.token)).toEqual({
      kind: 'valid',
      grantId: second.grant.id,
      scope: { kind: 'all' },
    });
    expect(store.resolve(first.token)).toEqual({ kind: 'revoked', grantId: first.grant.id });
  });

  test('revoke is durable across a reload', async () => {
    await store.load();
    const { grant, token } = await store.create({ label: 'x', scope: { kind: 'all' } });
    await store.revoke(grant.id);

    const reopened = new ViewerGrantStore(tempDir);
    await reopened.load();
    expect(reopened.resolve(token)).toEqual({ kind: 'revoked', grantId: grant.id });
  });

  test('canonical scope is persisted to disk, not just fixed up in memory', async () => {
    await store.load();
    const { grant, token } = await store.create({
      label: 'multi',
      scope: { kind: 'projects', projectIds: ['c', 'a', 'a', 'b'] },
    });
    const onDisk = JSON.parse(readFileSync(join(tempDir, 'share-grants.json'), 'utf-8'));
    expect(onDisk.grants[0].scope).toEqual({ kind: 'projects', projectIds: ['a', 'b', 'c'] });

    const reopened = new ViewerGrantStore(tempDir);
    await reopened.load();
    expect(reopened.resolve(token)).toEqual({
      kind: 'valid',
      grantId: grant.id,
      scope: { kind: 'projects', projectIds: ['a', 'b', 'c'] },
    });
  });

  test('two instances on different ports use different files (no collision)', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'viewer-grants-portA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'viewer-grants-portB-'));
    try {
      const a = new ViewerGrantStore(dirA);
      const b = new ViewerGrantStore(dirB);
      await a.load();
      await b.load();

      const { token: tokenA, grant: grantA } = await a.create({ label: 'A', scope: { kind: 'all' } });
      await b.create({ label: 'B', scope: { kind: 'all' } });

      expect(existsSync(join(dirA, 'share-grants.json'))).toBe(true);
      expect(existsSync(join(dirB, 'share-grants.json'))).toBe(true);

      // A's token resolves in A but is unknown to B (separate files).
      expect(a.resolve(tokenA)).toEqual({ kind: 'valid', grantId: grantA.id, scope: { kind: 'all' } });
      expect(b.resolve(tokenA)).toEqual({ kind: 'not-found' });
      expect(a.list()).toHaveLength(1);
      expect(b.list()).toHaveLength(1);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  describe('liveness (by grant id, for the sweep — #808)', () => {
    test('reports active / revoked / not-found, mirroring resolve()', async () => {
      await store.load();
      const { grant } = await store.create({ label: 'phone', scope: { kind: 'all' } });
      expect(store.liveness(grant.id)).toBe('active');

      await store.revoke(grant.id);
      expect(store.liveness(grant.id)).toBe('revoked');

      expect(store.liveness('no-such-id')).toBe('not-found');
    });

    test('reports expired for a past expiry and active for a future one', async () => {
      await store.load();
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      const { grant: expiredGrant } = await store.create({ label: 'old', scope: { kind: 'all' }, expiresAt: past });
      const { grant: liveGrant } = await store.create({ label: 'new', scope: { kind: 'all' }, expiresAt: future });
      expect(store.liveness(expiredGrant.id)).toBe('expired');
      expect(store.liveness(liveGrant.id)).toBe('active');
    });

    test('revoked-before-expiry: a revoked AND expired grant reports revoked', async () => {
      await store.load();
      const past = new Date(Date.now() - 60_000).toISOString();
      const { grant } = await store.create({ label: 'both', scope: { kind: 'all' }, expiresAt: past });
      await store.revoke(grant.id);
      expect(store.liveness(grant.id)).toBe('revoked');
    });
  });

  describe('isWritable (health signal — #808)', () => {
    test('a fresh, loaded store is writable', async () => {
      await store.load();
      expect(store.isWritable()).toBe(true);
    });

    test('stays writable after a successful create', async () => {
      await store.load();
      await store.create({ label: 'ok', scope: { kind: 'all' } });
      expect(store.isWritable()).toBe(true);
    });

    test('flips to not-writable when a persist fails', async () => {
      // Point the store at a path whose parent is a file, so the atomic write
      // (temp-in-same-dir + rename) cannot succeed.
      const filePath = join(tempDir, 'occupied');
      writeFileSync(filePath, 'x');
      const broken = new ViewerGrantStore(filePath); // kookrDir is actually a file
      // create() works without load() (grants default to []); the persist fails
      // because the temp-write target dir is really a file.
      await expect(broken.create({ label: 'fail', scope: { kind: 'all' } })).rejects.toThrow();
      expect(broken.isWritable()).toBe(false);
    });
  });

  describe('pruneExpired (bounded share-grant store — #2160)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Seed a share-grants.json record on disk with a known raw token (so the
    // caller can later assert resolution) and arbitrary timestamps.
    function seedGrantFile(
      grants: Array<{
        id: string;
        token: string;
        label?: string;
        createdAt?: string;
        expiresAt?: string;
        revokedAt?: string;
      }>,
    ): void {
      const records = grants.map((g) => ({
        id: g.id,
        tokenHash: createHash('sha256').update(g.token, 'utf8').digest('hex'),
        label: g.label ?? g.id,
        scope: { kind: 'all' as const },
        createdAt: g.createdAt ?? new Date(Date.now() - 90 * DAY_MS).toISOString(),
        ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}),
        ...(g.revokedAt ? { revokedAt: g.revokedAt } : {}),
      }));
      writeFileSync(
        join(tempDir, 'share-grants.json'),
        JSON.stringify({ schemaVersion: 1, grants: records }, null, 2),
      );
    }

    test('load() drops only aged terminal grants and keeps active + fresh terminal grants', async () => {
      const now = Date.now();
      seedGrantFile([
        { id: 'active-forever', token: 'a'.repeat(64) },
        { id: 'active-future-expiry', token: 'b'.repeat(64), expiresAt: new Date(now + 60 * DAY_MS).toISOString() },
        { id: 'fresh-revoked', token: 'c'.repeat(64), revokedAt: new Date(now - 60_000).toISOString() },
        { id: 'fresh-expired', token: 'd'.repeat(64), expiresAt: new Date(now - 60_000).toISOString() },
        { id: 'old-revoked', token: 'e'.repeat(64), revokedAt: new Date(now - 60 * DAY_MS).toISOString() },
        { id: 'old-expired', token: 'f'.repeat(64), expiresAt: new Date(now - 60 * DAY_MS).toISOString() },
      ]);

      await store.load();

      const ids = store.list().map((g) => g.id).sort();
      expect(ids).toEqual(
        ['active-forever', 'active-future-expiry', 'fresh-expired', 'fresh-revoked'].sort(),
      );

      // Active-grant resolution is unchanged by pruning.
      expect(store.resolve('a'.repeat(64))).toEqual({
        kind: 'valid',
        grantId: 'active-forever',
        scope: { kind: 'all' },
      });
      // The two aged terminal grants are gone from disk, not just from memory.
      const onDisk = readFileSync(join(tempDir, 'share-grants.json'), 'utf-8');
      expect(onDisk).not.toContain('old-revoked');
      expect(onDisk).not.toContain('old-expired');
      expect(onDisk).toContain('fresh-revoked');
    });

    test('a grant that is both revoked and expired retains until the later terminal stamp ages out', async () => {
      const now = Date.now();
      // Expired 60 days ago but only revoked 1 minute ago: the later stamp
      // (revokedAt) is still fresh, so the grant must be kept.
      seedGrantFile([
        {
          id: 'revoked-recently-expired-long-ago',
          token: 'a'.repeat(64),
          expiresAt: new Date(now - 60 * DAY_MS).toISOString(),
          revokedAt: new Date(now - 60_000).toISOString(),
        },
      ]);

      await store.load();
      expect(store.list().map((g) => g.id)).toEqual(['revoked-recently-expired-long-ago']);
    });

    test('pruneExpired persists the compaction to disk, and a no-op prune performs no write', async () => {
      const now = Date.now();
      // All terminal but only a minute ago → inside the 30-day default, so
      // load() keeps them and this test isolates the direct pruneExpired() calls.
      seedGrantFile([
        { id: 'keep', token: 'a'.repeat(64) },
        { id: 'fresh-revoked', token: 'b'.repeat(64), revokedAt: new Date(now - 60_000).toISOString() },
        { id: 'fresh-expired', token: 'c'.repeat(64), expiresAt: new Date(now - 60_000).toISOString() },
      ]);
      await store.load();
      expect(store.list().map((g) => g.id).sort()).toEqual(['fresh-expired', 'fresh-revoked', 'keep']);

      const filePath = join(tempDir, 'share-grants.json');
      // A no-op prune (generous window, nothing terminal old enough) writes nothing:
      // the return is 0 AND the on-disk file is left byte-for-byte untouched.
      const beforeMtime = statSync(filePath).mtimeMs;
      expect(await store.pruneExpired(365 * DAY_MS)).toBe(0);
      expect(statSync(filePath).mtimeMs).toBe(beforeMtime);

      // retentionMs=0 prunes both terminal grants and rewrites the compacted file.
      expect(await store.pruneExpired(0)).toBe(2);
      const onDisk = readFileSync(filePath, 'utf-8');
      expect(onDisk).not.toContain('fresh-revoked');
      expect(onDisk).not.toContain('fresh-expired');
      expect(onDisk).toContain('keep');
    });

    test('retentionMs argument controls the cutoff (0 prunes every terminal grant immediately)', async () => {
      await store.load();
      const { grant: revoked } = await store.create({ label: 'r', scope: { kind: 'all' } });
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.create({ label: 'e', scope: { kind: 'all' }, expiresAt: past });
      const { grant: active } = await store.create({ label: 'a', scope: { kind: 'all' } });
      await store.revoke(revoked.id);

      // With a generous window nothing is pruned yet (they only just became terminal).
      expect(await store.pruneExpired(365 * DAY_MS)).toBe(0);
      // retentionMs=0 prunes any grant that is terminal now, leaving only active.
      expect(await store.pruneExpired(0)).toBe(2);
      expect(store.list().map((g) => g.id)).toEqual([active.id]);
    });

    test('a negative retentionMs is clamped to 0 (not treated as a future cutoff)', async () => {
      const now = Date.now();
      // A future-dated revokedAt (clock skew / hand-edited file): terminal per
      // resolve(), but not yet "in the past". A clamped cutoff of `now` keeps it;
      // an unclamped negative retention would push the cutoff past it and drop it.
      seedGrantFile([
        { id: 'future-revoked', token: 'a'.repeat(64), revokedAt: new Date(now + 60_000).toISOString() },
      ]);
      await store.load();
      expect(await store.pruneExpired(-120_000)).toBe(0);
      expect(store.list().map((g) => g.id)).toEqual(['future-revoked']);
    });

    // chmod-based unwritable-dir trick is bypassed by root, so skip there.
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    test.skipIf(isRoot)(
      'prune-on-load tolerates a persist failure: load resolves, grants stay, store flagged not-writable',
      async () => {
        const now = Date.now();
        // Aged terminal grant → load() will try to prune AND persist the compaction.
        seedGrantFile([
          { id: 'old-revoked', token: 'a'.repeat(64), revokedAt: new Date(now - 60 * DAY_MS).toISOString() },
          { id: 'active', token: 'b'.repeat(64) },
        ]);
        // Make the directory read+execute but not writable: the seeded file is
        // still readable, but the atomic write (temp-in-same-dir + rename) fails.
        chmodSync(tempDir, 0o500);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          // load() must NOT throw — the compaction persist is best-effort.
          await expect(store.load()).resolves.toBeUndefined();
          // The uncompacted grants remain in memory and still serve resolution.
          expect(store.list().map((g) => g.id).sort()).toEqual(['active', 'old-revoked'].sort());
          expect(store.resolve('b'.repeat(64))).toEqual({
            kind: 'valid',
            grantId: 'active',
            scope: { kind: 'all' },
          });
          // The failed write is surfaced for the health signal and logged.
          expect(store.isWritable()).toBe(false);
          expect(warn.mock.calls.flat().join(' ')).toContain('Prune-on-load failed to persist');
        } finally {
          warn.mockRestore();
          chmodSync(tempDir, 0o700); // restore so afterEach's rmSync can clean up
        }
      },
    );
  });
});

describe('readGrantRetentionMsFromEnv', () => {
  test('defaults to 30 days when unset, blank, non-numeric, or negative', () => {
    expect(DEFAULT_GRANT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(readGrantRetentionMsFromEnv({})).toBe(DEFAULT_GRANT_RETENTION_MS);
    expect(readGrantRetentionMsFromEnv({ KOOKR_SHARE_GRANT_RETENTION_MS: '' })).toBe(DEFAULT_GRANT_RETENTION_MS);
    expect(readGrantRetentionMsFromEnv({ KOOKR_SHARE_GRANT_RETENTION_MS: '   ' })).toBe(DEFAULT_GRANT_RETENTION_MS);
    expect(readGrantRetentionMsFromEnv({ KOOKR_SHARE_GRANT_RETENTION_MS: 'soon' })).toBe(DEFAULT_GRANT_RETENTION_MS);
    expect(readGrantRetentionMsFromEnv({ KOOKR_SHARE_GRANT_RETENTION_MS: '-1' })).toBe(DEFAULT_GRANT_RETENTION_MS);
  });

  test('honours a valid non-negative override, including 0', () => {
    expect(readGrantRetentionMsFromEnv({ KOOKR_SHARE_GRANT_RETENTION_MS: '0' })).toBe(0);
    expect(readGrantRetentionMsFromEnv({ KOOKR_SHARE_GRANT_RETENTION_MS: '86400000' })).toBe(86_400_000);
  });
});
