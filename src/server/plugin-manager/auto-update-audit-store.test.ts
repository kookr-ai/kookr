import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoUpdateAuditStore, AUTO_UPDATE_AUDIT_FILENAME } from './auto-update-audit-store.js';
import type { AutoUpdateDecision } from '../../shared/contracts/plugins.js';

function dec(pluginId: string, n: number): AutoUpdateDecision {
  return { pluginId, evaluatedAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`, policy: 'apply-when-idle', state: 'skipped', reason: 'no-update' };
}

describe('AutoUpdateAuditStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-au-audit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('missing/malformed reads empty', async () => {
    const store = new AutoUpdateAuditStore(dir);
    expect(await store.readAll()).toEqual([]);
    writeFileSync(join(dir, AUTO_UPDATE_AUDIT_FILENAME), 'not json');
    expect(await store.readAll()).toEqual([]);
  });

  test('append is bounded: the 3 NEWEST survive, oldest-first, in order', async () => {
    const store = new AutoUpdateAuditStore(dir, 3);
    for (let i = 0; i < 5; i++) await store.append(dec('a@m', i));
    const all = await store.readAll();
    expect(all.map((d) => d.evaluatedAt)).toEqual([
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:04.000Z',
    ]);
  });

  test('recent returns newest-first', async () => {
    const store = new AutoUpdateAuditStore(dir);
    await store.append(dec('a@m', 0));
    await store.append(dec('b@m', 1));
    const recent = await store.recent(10);
    expect(recent[0].pluginId).toBe('b@m');
    expect(recent[1].pluginId).toBe('a@m');
  });

  test('lastFor returns the most recent decision for one plugin', async () => {
    const store = new AutoUpdateAuditStore(dir);
    await store.append(dec('a@m', 0));
    await store.append(dec('b@m', 1));
    await store.append({ ...dec('a@m', 2), state: 'applied' });
    const last = await store.lastFor('a@m');
    expect(last?.state).toBe('applied');
    expect(await store.lastFor('z@m')).toBeNull();
  });
});
