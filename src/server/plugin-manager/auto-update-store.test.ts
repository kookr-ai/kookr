import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoUpdateStore, AUTO_UPDATE_STORE_FILENAME } from './auto-update-store.js';

describe('AutoUpdateStore', () => {
  let dir: string;
  let store: AutoUpdateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-au-store-'));
    store = new AutoUpdateStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('missing file reads empty; absent policy ⇒ off', async () => {
    const data = await store.read();
    expect(data.policies).toEqual({});
    expect(await store.getPolicy('a@m')).toBe('off');
  });

  test('malformed file reads empty (never throws)', async () => {
    writeFileSync(join(dir, AUTO_UPDATE_STORE_FILENAME), '{ not json');
    expect((await store.read()).policies).toEqual({});
  });

  test('setPolicy persists; off removes the entry', async () => {
    await store.setPolicy('a@m', 'apply-when-idle');
    expect(await store.getPolicy('a@m')).toBe('apply-when-idle');
    await store.setPolicy('a@m', 'off');
    expect((await store.read()).policies).toEqual({});
  });

  test('coerces invalid policy / banner / snapshot entries away', async () => {
    writeFileSync(
      join(dir, AUTO_UPDATE_STORE_FILENAME),
      JSON.stringify({
        version: 1,
        policies: { 'a@m': 'apply-when-idle', 'b@m': 'bogus' },
        observed: { 'a@m': '1.0.0', 'c@m': 42 },
        banners: { 'a@m': { pluginId: 'a@m', kind: 'verify-failed', message: 'x', raisedAt: 't' }, bad: { kind: 'nope' } },
        snapshots: { 'a@m': { pluginId: 'a@m', installPath: '/p', snapshotPath: '/s', fromVersion: '1.0.0', takenAt: 't', retainUntil: 'u' }, bad: {} },
      }),
    );
    const data = await store.read();
    expect(data.policies).toEqual({ 'a@m': 'apply-when-idle' });
    expect(data.observed).toEqual({ 'a@m': '1.0.0' });
    expect(Object.keys(data.banners)).toEqual(['a@m']);
    expect(Object.keys(data.snapshots)).toEqual(['a@m']);
  });

  test('update() mutates and persists atomically', async () => {
    await store.update((d) => {
      d.observed['a@m'] = '2.0.0';
      d.banners['a@m'] = { pluginId: 'a@m', kind: 'post-session', message: 'm', raisedAt: 't' };
    });
    const data = await store.read();
    expect(data.observed['a@m']).toBe('2.0.0');
    expect(data.banners['a@m'].kind).toBe('post-session');
  });
});
