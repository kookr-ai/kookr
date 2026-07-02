import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CollaborationAuditLog, type CollaborationAuditAppendInput } from './collaboration-audit-log.js';

const BASE_INPUT: CollaborationAuditAppendInput = {
  actor: { kind: 'local-owner' },
  event: 'profile.changed',
};

describe('CollaborationAuditLog', () => {
  test('disabled sink reports configured false and zero append failures', async () => {
    const log = new CollaborationAuditLog({ filePath: null });

    expect(await log.append(BASE_INPUT)).toBe(true);
    expect(log.status()).toEqual({
      configured: false,
      writable: true,
      appendFailureCount: 0,
    });
  });

  test('append writes JSONL audit rows and keeps failure count at zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-'));
    try {
      const log = new CollaborationAuditLog({
        kookrDir: dir,
        now: () => new Date('2026-07-02T10:00:00.000Z'),
        idGenerator: () => 'event-1',
        ownerNodeId: 'owner-node',
      });

      expect(await log.append(BASE_INPUT)).toBe(true);

      expect(log.status()).toEqual({
        configured: true,
        writable: true,
        appendFailureCount: 0,
      });
      const lines = (await readFile(join(dir, 'collaboration-audit.jsonl'), 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        schemaVersion: 'collaboration-audit.v1',
        auditEventId: 'collab-audit-event-1',
        ts: '2026-07-02T10:00:00.000Z',
        ownerNodeId: 'owner-node',
        actor: { kind: 'local-owner' },
        transportKind: 'privateNetwork',
        event: 'profile.changed',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('failed appends mark sink unwritable and count failures monotonically across recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-'));
    try {
      const obstruction = join(dir, 'blocked-parent');
      await writeFile(obstruction, 'not a directory');
      let nowMs = Date.parse('2026-07-02T10:00:00.000Z');
      const log = new CollaborationAuditLog({
        filePath: join(obstruction, 'collaboration-audit.jsonl'),
        now: () => new Date(nowMs),
      });

      expect(await log.append(BASE_INPUT)).toBe(false);
      expect(await log.append(BASE_INPUT)).toBe(false);

      const failedStatus = log.status();
      expect(failedStatus.configured).toBe(true);
      expect(failedStatus.writable).toBe(false);
      expect(failedStatus.appendFailureCount).toBe(2);
      expect(failedStatus.lastFailure?.reason).toMatch(/EEXIST|ENOTDIR/);

      await rm(obstruction);
      await mkdir(obstruction);
      nowMs = Date.parse('2026-07-02T10:01:00.000Z');

      expect(await log.append(BASE_INPUT)).toBe(true);
      expect(log.status()).toEqual({
        configured: true,
        writable: true,
        appendFailureCount: 2,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
