import { describe, expect, test } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CollaborationAuditLog,
  statCollaborationAuditLogSize,
  type CollaborationAuditAppendInput,
} from './collaboration-audit-log.js';

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

  test.runIf(process.platform !== 'win32')(
    'persists collaboration-audit.jsonl owner-only (mode 0o600) after the first append',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-mode-'));
      try {
        const log = new CollaborationAuditLog({ kookrDir: dir });
        const filePath = join(dir, 'collaboration-audit.jsonl');

        expect(await log.append(BASE_INPUT)).toBe(true);
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== 'win32')(
    'append still succeeds when chmod is a no-op on an already owner-only file',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-mode-'));
      try {
        const filePath = join(dir, 'collaboration-audit.jsonl');
        await writeFile(filePath, '', { mode: 0o600 });
        await chmod(filePath, 0o600);
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);

        const log = new CollaborationAuditLog({
          kookrDir: dir,
          now: () => new Date('2026-07-02T10:00:00.000Z'),
          idGenerator: () => 'event-1',
        });

        expect(await log.append(BASE_INPUT)).toBe(true);
        expect(log.status()).toEqual({
          configured: true,
          writable: true,
          appendFailureCount: 0,
        });
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
        const lines = (await readFile(filePath, 'utf-8')).trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!).auditEventId).toBe('collab-audit-event-1');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== 'win32')(
    'tightens a pre-existing world-readable collaboration-audit.jsonl on the next append',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-mode-'));
      try {
        const filePath = join(dir, 'collaboration-audit.jsonl');
        await writeFile(filePath, '', { mode: 0o644 });
        await chmod(filePath, 0o644);
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);

        const log = new CollaborationAuditLog({ kookrDir: dir });
        expect(await log.append(BASE_INPUT)).toBe(true);
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

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

describe('statCollaborationAuditLogSize (issue #3158)', () => {
  test('returns null when the collaboration-audit log is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-size-'));
    try {
      expect(await statCollaborationAuditLogSize(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reports the active file byte size after an append', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-size-'));
    try {
      const log = new CollaborationAuditLog({
        kookrDir: dir,
        idGenerator: () => 'event-1',
        ownerNodeId: 'owner-node',
      });
      expect(await log.append(BASE_INPUT)).toBe(true);

      const bytes = await statCollaborationAuditLogSize(dir);
      const raw = await readFile(join(dir, 'collaboration-audit.jsonl'), 'utf-8');
      expect(bytes).toBe(Buffer.byteLength(raw));
      expect(bytes).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
