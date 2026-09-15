import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CollaborationAuditLog,
  DEFAULT_COLLABORATION_AUDIT_MAX_BYTES,
  DEFAULT_COLLABORATION_AUDIT_ROTATED_GENERATIONS,
  COLLABORATION_AUDIT_FILE_NAME,
  statCollaborationAuditLogSize,
  type CollaborationAuditAppendInput,
} from './collaboration-audit-log.js';

const BASE_INPUT: CollaborationAuditAppendInput = {
  actor: { kind: 'local-owner' },
  event: 'profile.changed',
};

function parseJsonl(raw: string): unknown[] {
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('CollaborationAuditLog', () => {
  test('exports conservative default rotation thresholds', () => {
    expect(DEFAULT_COLLABORATION_AUDIT_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(DEFAULT_COLLABORATION_AUDIT_ROTATED_GENERATIONS).toBe(2);
  });

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

  test.runIf(process.platform !== 'win32')(
    'tightens a world-readable generation after it is rotated to .1',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-mode-'));
      try {
        const filePath = join(dir, COLLABORATION_AUDIT_FILE_NAME);
        await writeFile(filePath, `${'x'.repeat(200)}\n`, { mode: 0o644 });
        await chmod(filePath, 0o644);
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);

        const log = new CollaborationAuditLog({ kookrDir: dir, maxBytes: 80, rotatedGenerations: 2 });
        expect(await log.append(BASE_INPUT)).toBe(true);
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
        expect((await stat(`${filePath}.1`)).mode & 0o777).toBe(0o600);
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

  test('reports the bounded active file after rotation, not retained generations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-size-'));
    try {
      let seq = 0;
      const log = new CollaborationAuditLog({
        kookrDir: dir,
        idGenerator: () => `event-${++seq}`,
        ownerNodeId: 'owner-node',
        maxBytes: 80,
        rotatedGenerations: 2,
      });
      expect(await log.append(BASE_INPUT)).toBe(true);
      expect(await log.append({ ...BASE_INPUT, reason: 'post-rotation-active' })).toBe(true);

      const activePath = join(dir, COLLABORATION_AUDIT_FILE_NAME);
      const rotatedPath = `${activePath}.1`;
      expect(existsSync(rotatedPath)).toBe(true);

      const bytes = await statCollaborationAuditLogSize(dir);
      const activeRaw = await readFile(activePath, 'utf-8');
      const rotatedRaw = await readFile(rotatedPath, 'utf-8');
      expect(bytes).toBe(Buffer.byteLength(activeRaw));
      expect(bytes).not.toBe(Buffer.byteLength(rotatedRaw));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('CollaborationAuditLog rotation (issue #3252)', () => {
  test('writing past the cap produces a rotated .1 generation and a bounded active file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-rotate-'));
    try {
      let seq = 0;
      const log = new CollaborationAuditLog({
        kookrDir: dir,
        now: () => new Date('2026-07-02T10:00:00.000Z'),
        idGenerator: () => `event-${++seq}`,
        ownerNodeId: 'owner-node',
        maxBytes: 80,
        rotatedGenerations: 2,
      });

      expect(await log.append(BASE_INPUT)).toBe(true);
      expect(await log.append(BASE_INPUT)).toBe(true);
      expect(await log.append({ ...BASE_INPUT, reason: 'post-rotation-active' })).toBe(true);

      const activePath = join(dir, COLLABORATION_AUDIT_FILE_NAME);
      const activeRaw = await readFile(activePath, 'utf-8');
      const rotated1 = await readFile(`${activePath}.1`, 'utf-8');
      const rotated2 = await readFile(`${activePath}.2`, 'utf-8');

      const activeRows = parseJsonl(activeRaw);
      const rotated1Rows = parseJsonl(rotated1);
      const rotated2Rows = parseJsonl(rotated2);
      expect(activeRows).toHaveLength(1);
      expect(rotated1Rows).toHaveLength(1);
      expect(rotated2Rows).toHaveLength(1);
      expect(activeRows[0]).toMatchObject({
        auditEventId: 'collab-audit-event-3',
        reason: 'post-rotation-active',
      });
      expect(rotated1Rows[0]).toMatchObject({ auditEventId: 'collab-audit-event-2' });
      expect(rotated2Rows[0]).toMatchObject({ auditEventId: 'collab-audit-event-1' });
      expect(existsSync(`${activePath}.3`)).toBe(false);

      const activeBytes = Buffer.byteLength(activeRaw);
      expect(activeBytes).toBe(Buffer.byteLength(`${JSON.stringify(activeRows[0])}\n`));
      expect(activeBytes).not.toBe(Buffer.byteLength(rotated1));
      expect(activeBytes).toBe((await stat(activePath)).size);
      expect(await statCollaborationAuditLogSize(dir)).toBe(activeBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('existing consumers still append one JSON object per line across rotation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-jsonl-'));
    try {
      let seq = 0;
      const log = new CollaborationAuditLog({
        kookrDir: dir,
        idGenerator: () => `event-${++seq}`,
        maxBytes: 80,
        rotatedGenerations: 2,
      });

      expect(await log.append(BASE_INPUT)).toBe(true);
      expect(await log.append({ ...BASE_INPUT, decision: 'allowed', reason: 'ok' })).toBe(true);

      const activePath = join(dir, COLLABORATION_AUDIT_FILE_NAME);
      for (const path of [activePath, `${activePath}.1`]) {
        const rows = parseJsonl(await readFile(path, 'utf-8'));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ schemaVersion: 'collaboration-audit.v1' });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('serialized concurrent appends do not drop rows when rotation fires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-audit-concurrent-'));
    try {
      let seq = 0;
      const log = new CollaborationAuditLog({
        kookrDir: dir,
        idGenerator: () => `event-${++seq}`,
        maxBytes: 80,
        rotatedGenerations: 2,
      });

      const results = await Promise.all([
        log.append(BASE_INPUT),
        log.append(BASE_INPUT),
        log.append(BASE_INPUT),
      ]);
      expect(results).toEqual([true, true, true]);

      const activePath = join(dir, COLLABORATION_AUDIT_FILE_NAME);
      const rows = [
        ...parseJsonl(await readFile(activePath, 'utf-8')),
        ...parseJsonl(await readFile(`${activePath}.1`, 'utf-8')),
        ...parseJsonl(await readFile(`${activePath}.2`, 'utf-8')),
      ];
      const ids = rows.map((row) => (row as { auditEventId: string }).auditEventId).sort();
      expect(ids).toEqual([
        'collab-audit-event-1',
        'collab-audit-event-2',
        'collab-audit-event-3',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
