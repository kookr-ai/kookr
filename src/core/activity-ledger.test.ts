import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLedger, type ActivityLedgerRow, type HookEnvelopeV1 } from './activity-ledger.js';

function envelope(overrides: Partial<HookEnvelopeV1> = {}): HookEnvelopeV1 {
  return {
    schemaVersion: 'hook-envelope.v1',
    kookrSessionId: 'kookr-test',
    provider: 'claude-code',
    source: 'file',
    observedAt: '2026-05-13T12:00:00.000Z',
    sequence: 1,
    contentHash: 'a'.repeat(64),
    parentage: 'parent',
    parseStatus: 'ok',
    rawBytes: 128,
    ...overrides,
  };
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'kookr-activity-ledger-'));
}

describe('ActivityLedger', () => {
  it('writes one JSONL row per append, newline-terminated', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await ledger.append({ envelope: envelope({ sequence: 1 }) });
      await ledger.append({ envelope: envelope({ sequence: 2 }) });
      const rows = await ledger.readAll('kookr-test');
      expect(rows).toHaveLength(2);
      expect(rows[0].envelope.sequence).toBe(1);
      expect(rows[1].envelope.sequence).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses one ledger file per Kookr session', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await ledger.append({ envelope: envelope({ kookrSessionId: 'kookr-a' }) });
      await ledger.append({ envelope: envelope({ kookrSessionId: 'kookr-b' }) });
      await ledger.flush();
      expect((await ledger.readAll('kookr-a'))).toHaveLength(1);
      expect((await ledger.readAll('kookr-b'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent appends for the same session', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          ledger.append({ envelope: envelope({ sequence: i + 1 }) }),
        ),
      );
      const rows = await ledger.readAll('kookr-test');
      expect(rows.map((r) => r.envelope.sequence)).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates ledger file with owner-only mode 0600', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await ledger.append({ envelope: envelope() });
      await ledger.flush();
      const mode = statSync(ledger.pathFor('kookr-test')).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports zeroed stats for a session with no ledger file', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      const s = await ledger.stats('kookr-nope');
      expect(s).toEqual({
        kookrSessionId: 'kookr-nope',
        rawRecordCount: 0,
        parsedRecordCount: 0,
        malformedRecordCount: 0,
        duplicateRecordCount: 0,
        droppedRecordCount: 0,
        parentEventCount: 0,
        childEventCount: 0,
        foreignEventCount: 0,
        unknownParentageCount: 0,
        rawBytesTotal: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarizes counts across parentage and parseStatus', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      const rows: ActivityLedgerRow[] = [
        { envelope: envelope({ sequence: 1, parentage: 'parent', parseStatus: 'ok', rawBytes: 100 }), projection: 'parent_activity' },
        { envelope: envelope({ sequence: 2, parentage: 'child', parseStatus: 'ok', rawBytes: 200 }), projection: 'child_activity' },
        { envelope: envelope({ sequence: 3, parentage: 'unknown', parseStatus: 'malformed', rawBytes: 50 }), error: 'bad json' },
        { envelope: envelope({ sequence: 4, parentage: 'parent', parseStatus: 'ok', rawBytes: 150 }), projection: 'diagnostic_only' },
      ];
      for (const r of rows) await ledger.append(r);
      const s = await ledger.stats('kookr-test');
      expect(s.rawRecordCount).toBe(4);
      expect(s.parsedRecordCount).toBe(3);
      expect(s.malformedRecordCount).toBe(1);
      expect(s.duplicateRecordCount).toBe(1);
      expect(s.parentEventCount).toBe(2);
      expect(s.childEventCount).toBe(1);
      expect(s.unknownParentageCount).toBe(1);
      expect(s.rawBytesTotal).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes a session ledger and ignores re-prune of missing file', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await ledger.append({ envelope: envelope() });
      await ledger.flush();
      await ledger.pruneSession('kookr-test');
      const s = await ledger.stats('kookr-test');
      expect(s.rawRecordCount).toBe(0);
      // Idempotent — second prune on missing file does not throw.
      await ledger.pruneSession('kookr-test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not duplicate raw payload bytes in ledger rows', async () => {
    // RFC §11 privacy guardrail: ledger row carries rawBytes count, not raw text.
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await ledger.append({ envelope: envelope() });
      await ledger.flush();
      const path = ledger.pathFor('kookr-test');
      const { readFileSync } = await import('node:fs');
      const line = readFileSync(path, 'utf8');
      expect(line).not.toContain('"raw"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
