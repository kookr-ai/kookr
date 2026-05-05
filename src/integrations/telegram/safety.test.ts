import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLockOrFail,
  createTokenBucket,
  DailyCap,
  LockBusyError,
  PendingStore,
  StateStore,
  ensureIntegrationDir,
} from './safety.js';

describe('createTokenBucket', () => {
  it('allows up to N requests per minute', () => {
    const b = createTokenBucket(3);
    expect(b.allow(1)).toBe(true);
    expect(b.allow(1)).toBe(true);
    expect(b.allow(1)).toBe(true);
    expect(b.allow(1)).toBe(false);
  });

  it('isolates by sender id', () => {
    const b = createTokenBucket(1);
    expect(b.allow(1)).toBe(true);
    expect(b.allow(2)).toBe(true);
    expect(b.allow(1)).toBe(false);
  });
});

describe('acquireLockOrFail', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kookr-lock-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('succeeds when no lock exists', async () => {
    const handle = await acquireLockOrFail(join(tmp, 'lock'));
    await handle.release();
  });

  it('throws LockBusyError when held by a live process (this test process)', async () => {
    const path = join(tmp, 'lock');
    const a = await acquireLockOrFail(path);
    await expect(acquireLockOrFail(path)).rejects.toBeInstanceOf(LockBusyError);
    await a.release();
  });

  it('takes over a stale lock (pid not alive)', async () => {
    const path = join(tmp, 'lock');
    // Plant a stale lock with a pid that very likely does not exist.
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, JSON.stringify({ pid: 999_999, startedAt: '2020-01-01' }));
    const a = await acquireLockOrFail(path);
    await a.release();
  });
});

describe('StateStore + DailyCap', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kookr-state-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('persists offset across instances', async () => {
    const path = join(tmp, 'state.json');
    const a = await StateStore.open(path);
    await a.update((s) => { s.offset = 42; });
    const b = await StateStore.open(path);
    expect(b.get().offset).toBe(42);
  });

  it('checkAndReserveSpawn allows up to maxSpawnsPerDay', async () => {
    const state = await StateStore.open(join(tmp, 'state.json'));
    const cap = new DailyCap(2, state);
    expect((await cap.checkAndReserveSpawn()).allowed).toBe(true);
    expect((await cap.checkAndReserveSpawn()).allowed).toBe(true);
    expect((await cap.checkAndReserveSpawn()).allowed).toBe(false);
  });

  it('rolling 24h window: old entries do not count', async () => {
    const state = await StateStore.open(join(tmp, 'state.json'));
    const cap = new DailyCap(2, state);
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await state.update((s) => { s.spawnsByMs.push(dayAgo, dayAgo - 1, dayAgo - 2); });
    expect((await cap.checkAndReserveSpawn()).allowed).toBe(true);
    expect((await cap.checkAndReserveSpawn()).allowed).toBe(true);
    expect((await cap.checkAndReserveSpawn()).allowed).toBe(false);
  });

  it('view() reports current usage', async () => {
    const state = await StateStore.open(join(tmp, 'state.json'));
    const cap = new DailyCap(10, state);
    expect(cap.view().spawnsLast24h).toBe(0);
    await cap.checkAndReserveSpawn();
    await cap.checkAndReserveSpawn();
    expect(cap.view().spawnsLast24h).toBe(2);
  });

  it('survives a corrupted state.json by starting fresh', async () => {
    const fs = await import('node:fs/promises');
    const path = join(tmp, 'state.json');
    await fs.writeFile(path, 'not json');
    const a = await StateStore.open(path);
    expect(a.get().offset).toBe(0);
  });

  it('persists Telegram agent defaults by sender id', async () => {
    const path = join(tmp, 'state.json');
    const a = await StateStore.open(path);
    await a.update((s) => { s.agentDefaultsByUser['12345'] = 'codex-cli'; });

    const b = await StateStore.open(path);
    expect(b.get().agentDefaultsByUser['12345']).toBe('codex-cli');
  });
});

describe('PendingStore', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kookr-pending-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('write + consume returns the spec exactly once', async () => {
    const store = await PendingStore.open(join(tmp, 'pending'));
    await store.write('h1', { createdAt: Date.now(), spec: { prompt: 'p', cwd: '/c', agentType: 'codex-cli' }, chatId: 7 });
    const got = await store.consume('h1');
    expect(got?.chatId).toBe(7);
    expect(got?.spec.agentType).toBe('codex-cli');
    expect(await store.consume('h1')).toBeNull();
  });

  it('consume returns null for missing hash', async () => {
    const store = await PendingStore.open(join(tmp, 'pending'));
    expect(await store.consume('does-not-exist')).toBeNull();
  });

  it('gc removes files older than maxAge', async () => {
    const store = await PendingStore.open(join(tmp, 'pending'));
    await store.write('h1', { createdAt: 1, spec: { prompt: 'p', cwd: '/c', agentType: 'claude-code' }, chatId: 1 });
    // Force the file's mtime to be old.
    const fs = await import('node:fs/promises');
    const path = join(tmp, 'pending', 'h1.json');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(path, old, old);
    const removed = await store.gc(24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(await store.consume('h1')).toBeNull();
  });
});

describe('ensureIntegrationDir', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kookr-integ-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns paths under <dataDir>/telegram/', async () => {
    const paths = await ensureIntegrationDir(tmp);
    expect(paths.dir).toBe(join(tmp, 'telegram'));
    expect(paths.lock).toBe(join(tmp, 'telegram', 'lock'));
    expect(paths.state).toBe(join(tmp, 'telegram', 'state.json'));
    expect(paths.audit).toBe(join(tmp, 'telegram', 'audit.jsonl'));
    expect(paths.pendingDir).toBe(join(tmp, 'telegram', 'pending'));
  });
});
