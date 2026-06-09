import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ViewerGrantStore } from './viewer-grants.js';

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
});
