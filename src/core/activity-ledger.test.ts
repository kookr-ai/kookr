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
        // Duplicate of row 1 (same hash arriving via the other source). RFC §8:
        // a duplicate row inherits the original parentage in the envelope but
        // does NOT re-count toward parentEventCount — duplicateRecordCount is
        // a separate bucket.
        { envelope: envelope({ sequence: 4, parentage: 'parent', parseStatus: 'ok', rawBytes: 150 }), projection: 'diagnostic_only' },
      ];
      for (const r of rows) await ledger.append(r);
      const s = await ledger.stats('kookr-test');
      expect(s.rawRecordCount).toBe(4);
      expect(s.parsedRecordCount).toBe(3);
      expect(s.malformedRecordCount).toBe(1);
      expect(s.duplicateRecordCount).toBe(1);
      expect(s.parentEventCount).toBe(1);
      expect(s.childEventCount).toBe(1);
      // Malformed rows don't contribute to parentage buckets — they go into
      // malformedRecordCount only.
      expect(s.unknownParentageCount).toBe(0);
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

  it('rotates the current ledger to <name>.1 when adding a row would exceed maxFileBytes', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir, { maxFileBytes: 250 });
      // First row creates the file under the cap. The second row overflows it
      // — the cap-check fires BEFORE the write, so row 1 is moved to .1 and
      // row 2 lands in a fresh file. This is the simple single-step rotation
      // RFC §7 describes; .1 is overwritten on each subsequent rollover
      // rather than archived indefinitely.
      await ledger.append({ envelope: envelope({ sequence: 1, rawBytes: 64 }) });
      await ledger.append({ envelope: envelope({ sequence: 2, rawBytes: 64 }) });
      await ledger.flush();

      const { readFileSync, existsSync } = await import('node:fs');
      const rotatedPath = `${ledger.pathFor('kookr-test')}.1`;
      expect(existsSync(rotatedPath)).toBe(true);
      const current = readFileSync(ledger.pathFor('kookr-test'), 'utf8');
      const rotated = readFileSync(rotatedPath, 'utf8');
      const currentRows = current.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const rotatedRows = rotated.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(rotatedRows).toHaveLength(1);
      expect(rotatedRows[0].envelope.sequence).toBe(1);
      expect(currentRows).toHaveLength(1);
      expect(currentRows[0].envelope.sequence).toBe(2);
      expect((await ledger.readAll('kookr-test')).map((row) => row.envelope.sequence)).toEqual([1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('subsequent rotations overwrite the prior .1 — total disk usage stays bounded', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir, { maxFileBytes: 250 });
      for (const sequence of [1, 2, 3]) {
        await ledger.append({ envelope: envelope({ sequence, rawBytes: 64 }) });
      }
      await ledger.flush();

      const { readFileSync } = await import('node:fs');
      const current = readFileSync(ledger.pathFor('kookr-test'), 'utf8');
      const rotated = readFileSync(`${ledger.pathFor('kookr-test')}.1`, 'utf8');
      const currentRows = current.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const rotatedRows = rotated.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      // Row 1 has been discarded by the second rotation; .1 now holds row 2.
      expect(rotatedRows.map((r) => r.envelope.sequence)).toEqual([2]);
      expect(currentRows.map((r) => r.envelope.sequence)).toEqual([3]);
      expect((await ledger.readAll('kookr-test')).map((row) => row.envelope.sequence)).toEqual([2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pruneSession removes both the current ledger file and the .1 rotation', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir, { maxFileBytes: 250 });
      await ledger.append({ envelope: envelope({ sequence: 1, rawBytes: 64 }) });
      await ledger.append({ envelope: envelope({ sequence: 2, rawBytes: 64 }) });
      await ledger.append({ envelope: envelope({ sequence: 3, rawBytes: 64 }) });
      await ledger.flush();

      const { existsSync } = await import('node:fs');
      const main = ledger.pathFor('kookr-test');
      const rotated = `${main}.1`;
      expect(existsSync(rotated)).toBe(true);

      await ledger.pruneSession('kookr-test');
      expect(existsSync(main)).toBe(false);
      expect(existsSync(rotated)).toBe(false);
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

  it('rejects unsafe session ids before constructing a ledger path', () => {
    const ledger = new ActivityLedger('/tmp/kookr-ledger-test');

    expect(() => ledger.pathFor('../escape')).toThrow('Invalid Kookr session id');
    expect(() => ledger.pathFor('kookr/escape')).toThrow('Invalid Kookr session id');
  });
});
