import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DelegationStore, pruneTerminal, type Delegation } from './store.js';
import { rec } from './__fixtures__/builders.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-store-'));
  file = join(dir, 'delegations.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeStore(max?: number) {
  return new DelegationStore(file, { newInstanceId: () => 'inst0001', ...(max ? { maxTerminalRecords: max } : {}) });
}

const add = (r: Delegation) => (records: readonly Delegation[]) => ({ next: [...records, r], result: r.id });

describe('DelegationStore', () => {
  test('an absent file is an empty store (and not an error)', async () => {
    const s = makeStore();
    expect(await s.load()).toEqual({ ok: true });
    expect(s.list()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  test('writes atomically with mode 0600, no temp files left, and round-trips', async () => {
    const s = makeStore();
    await s.load();
    await s.transact(add(rec({ id: 'a' })));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['delegations.json']);
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk).toMatchObject({ schemaVersion: 1, instanceId: 'inst0001' });
    expect(onDisk.delegations).toHaveLength(1);

    const s2 = makeStore();
    expect(await s2.load()).toEqual({ ok: true });
    expect(s2.get('a')?.id).toBe('a');
    expect(s2.id).toBe('inst0001');
  });

  test('an unparseable file disables the store with a typed error naming the file, and is never treated as empty', async () => {
    writeFileSync(file, '{ not json');
    const s = makeStore();
    const r = await s.load();
    expect(r).toMatchObject({ ok: false, error: { code: 'store_unparseable', file } });
    expect(readFileSync(file, 'utf-8')).toBe('{ not json'); // untouched
  });

  test('a structurally wrong file is unparseable, not empty', async () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, delegations: 'nope' }));
    expect(await makeStore().load()).toMatchObject({ ok: false, error: { code: 'store_unparseable' } });
  });

  test('a malformed record anywhere disables the store', async () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, instanceId: 'x', delegations: [rec({ id: 'ok' }), { id: 'bad' }] }));
    expect(await makeStore().load()).toMatchObject({ ok: false, error: { code: 'store_unparseable', file } });
  });

  test('an unknown schemaVersion disables the store', async () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, instanceId: 'x', delegations: [] }));
    const r = await makeStore().load();
    expect(r).toMatchObject({ ok: false, error: { code: 'store_unknown_schema', file } });
  });

  test('a directory where the file should be is reported as unreadable', async () => {
    const s = new DelegationStore(dir, { newInstanceId: () => 'i' });
    expect(await s.load()).toMatchObject({ ok: false, error: { code: 'store_unreadable' } });
  });

  test('tolerant reader: unknown fields on the file and on records are ignored and preserved', async () => {
    const r = { ...rec({ id: 'a' }), futureField: { x: 1 } };
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, instanceId: 'inst', delegations: [r], futureTop: 'keep' }));
    const s = makeStore();
    expect(await s.load()).toEqual({ ok: true });
    expect(s.get('a')).toBeDefined();
    await s.transact(add(rec({ id: 'b' })));
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk.futureTop).toBe('keep');
    expect(onDisk.delegations[0].futureField).toEqual({ x: 1 });
  });

  test('concurrent transactions are serialized and none loses another update', async () => {
    const s = makeStore();
    await s.load();
    const ids = Array.from({ length: 40 }, (_, i) => `r${i}`);
    await Promise.all(ids.map((id) => s.transact(add(rec({ id })))));
    expect(s.list().map((r) => r.id).sort()).toEqual([...ids].sort());
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk.delegations).toHaveLength(40);
  });

  test('check-then-insert inside one transaction is atomic', async () => {
    const s = makeStore();
    await s.load();
    const tryInsert = (id: string) =>
      s.transact((records) =>
        records.some((r) => r.key === 'K') ? { result: 'dup' as const } : { next: [...records, rec({ id, key: 'K' })], result: 'created' as const },
      );
    const results = await Promise.all([tryInsert('a'), tryInsert('b'), tryInsert('c')]);
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(s.list()).toHaveLength(1);
  });

  test('a failed write rejects, leaves committed state untouched, and does not wedge the queue', async () => {
    const s = new DelegationStore(join(dir, 'missing-parent-is-created', 'x', 'delegations.json'), { newInstanceId: () => 'i' });
    await s.load();
    await s.transact(add(rec({ id: 'a' })));
    // Make the next write fail by replacing the parent directory with a file.
    rmSync(join(dir, 'missing-parent-is-created'), { recursive: true, force: true });
    writeFileSync(join(dir, 'missing-parent-is-created'), 'blocker');
    await expect(s.transact(add(rec({ id: 'b' })))).rejects.toThrow();
    expect(s.list().map((r) => r.id)).toEqual(['a']);
    rmSync(join(dir, 'missing-parent-is-created'), { force: true });
    await s.transact(add(rec({ id: 'c' })));
    expect(s.list().map((r) => r.id)).toEqual(['a', 'c']);
  });

  test('reads only see committed state (the write-ahead is durable before it is visible)', async () => {
    const s = makeStore();
    await s.load();
    const p = s.transact(add(rec({ id: 'a' })));
    expect(s.get('a')).toBeUndefined();
    await p;
    expect(s.get('a')).toBeDefined();
  });

  test('transact before load() throws', async () => {
    await expect(makeStore().transact(() => ({ result: 1 }))).rejects.toThrow(/before load/);
  });

  test('keeps at most N terminal records (newest), never prunes non-terminal ones', async () => {
    const s = makeStore(10);
    await s.load();
    for (let i = 0; i < 15; i++) {
      await s.transact(add(rec({ id: `t${i}`, state: 'completed', submittedAt: i, finishedAt: i })));
    }
    await s.transact(add(rec({ id: 'live', state: 'working', submittedAt: 0 })));
    const ids = s.list().map((r) => r.id);
    expect(ids).toContain('live');
    expect(ids.filter((i) => i.startsWith('t'))).toHaveLength(10);
    expect(ids).toContain('t14');
    expect(ids).not.toContain('t0');
  });

  test('pruneTerminal is a no-op under the limit', () => {
    const records = [rec({ state: 'completed' }), rec({ state: 'working' })];
    expect(pruneTerminal(records, 5)).toBe(records);
  });
});
