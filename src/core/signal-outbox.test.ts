import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  appendSignalOutbox,
  boundSignalOutbox,
  buildSignalOutboxEntry,
  DEFAULT_SIGNAL_OUTBOX_MAX_AGE_MS,
  DEFAULT_SIGNAL_OUTBOX_MAX_ENTRIES,
  drainSignalOutbox,
  newSignalId,
  readPendingSignals,
  removeSignalOutboxEntry,
  signalOutboxPendingPath,
} from './signal-outbox.js';

async function tempSpoolDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-signal-outbox-'));
}

describe('buildSignalOutboxEntry', () => {
  test('generates a signalId and trims fields', () => {
    const entry = buildSignalOutboxEntry({
      taskId: '  t-1  ',
      kind: 'completion_ready',
      note: '  done  ',
    });
    expect(entry.taskId).toBe('t-1');
    expect(entry.kind).toBe('completion_ready');
    expect(entry.note).toBe('done');
    expect(entry.signalId.length).toBeGreaterThan(8);
    expect(entry.schemaVersion).toBe('signal-outbox.v1');
  });

  test('honours an explicit signalId', () => {
    const id = newSignalId();
    expect(buildSignalOutboxEntry({
      signalId: id,
      taskId: 't',
      kind: 'completion_ready',
    }).signalId).toBe(id);
  });
});

describe('appendSignalOutbox + drainSignalOutbox', () => {
  test('spools a signal durably and survives re-read', async () => {
    const spoolDir = await tempSpoolDir();
    const entry = buildSignalOutboxEntry({
      taskId: 'task-1',
      kind: 'completion_ready',
      note: 'PR opened',
    });
    const result = await appendSignalOutbox(spoolDir, entry);
    expect(result.appended).toBe(true);
    expect(result.reason).toBe('appended');

    const pending = await readPendingSignals(spoolDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.signalId).toBe(entry.signalId);
    expect(pending[0]!.taskId).toBe('task-1');
    expect(pending[0]!.note).toBe('PR opened');

    const raw = await readFile(signalOutboxPendingPath(spoolDir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  test('duplicate signalId is a no-op append', async () => {
    const spoolDir = await tempSpoolDir();
    const entry = buildSignalOutboxEntry({
      signalId: 'sig-1',
      taskId: 't',
      kind: 'completion_ready',
    });
    await appendSignalOutbox(spoolDir, entry);
    const second = await appendSignalOutbox(spoolDir, {
      ...entry,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(second.appended).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(await readPendingSignals(spoolDir)).toHaveLength(1);
  });

  test('drain delivers successfully and empties the spool (idempotent re-drain)', async () => {
    const spoolDir = await tempSpoolDir();
    const e1 = buildSignalOutboxEntry({ taskId: 't1', kind: 'completion_ready' });
    const e2 = buildSignalOutboxEntry({ taskId: 't2', kind: 'completion_ready' });
    await appendSignalOutbox(spoolDir, e1);
    await appendSignalOutbox(spoolDir, e2);

    const seen: string[] = [];
    const first = await drainSignalOutbox({
      spoolDir,
      deliver: async (entry) => {
        seen.push(entry.taskId);
        return { outcome: 'delivered' };
      },
    });
    expect(first.delivered).toBe(2);
    expect(first.remaining).toBe(0);
    expect(seen).toEqual(['t1', 't2']);
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);

    const second = await drainSignalOutbox({
      spoolDir,
      deliver: async () => {
        throw new Error('should not be called on empty spool');
      },
    });
    expect(second.attempted).toBe(0);
    expect(second.delivered).toBe(0);
  });

  test('drain keeps transient failures and drops permanent ones', async () => {
    const spoolDir = await tempSpoolDir();
    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'ok',
      taskId: 't-ok',
      kind: 'completion_ready',
    }));
    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'perm',
      taskId: 't-perm',
      kind: 'completion_ready',
    }));
    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'tmp',
      taskId: 't-tmp',
      kind: 'completion_ready',
    }));

    const first = await drainSignalOutbox({
      spoolDir,
      deliver: async (entry) => {
        if (entry.signalId === 'perm') return { outcome: 'permanent_fail', error: 'task terminal' };
        if (entry.signalId === 'tmp') return { outcome: 'transient_fail', error: 'connection refused' };
        return { outcome: 'delivered' };
      },
    });
    expect(first.delivered).toBe(1);
    expect(first.permanentFailed).toBe(1);
    expect(first.transientFailed).toBe(1);
    expect(first.remaining).toBe(1);

    const remaining = await readPendingSignals(spoolDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.signalId).toBe('tmp');
    expect(remaining[0]!.lastError).toBe('connection refused');
    expect(remaining[0]!.attemptCount).toBe(1);
  });

  test('removeSignalOutboxEntry drops a single id', async () => {
    const spoolDir = await tempSpoolDir();
    const a = buildSignalOutboxEntry({ signalId: 'a', taskId: 't', kind: 'completion_ready' });
    const b = buildSignalOutboxEntry({ signalId: 'b', taskId: 't', kind: 'completion_ready' });
    await appendSignalOutbox(spoolDir, a);
    await appendSignalOutbox(spoolDir, b);
    expect(await removeSignalOutboxEntry(spoolDir, 'a')).toBe(true);
    expect((await readPendingSignals(spoolDir)).map((e) => e.signalId)).toEqual(['b']);
    expect(await removeSignalOutboxEntry(spoolDir, 'missing')).toBe(false);
  });
});

describe('boundSignalOutbox', () => {
  test('drops entries older than maxAgeMs', () => {
    const now = new Date('2026-07-25T12:00:00.000Z');
    const fresh = buildSignalOutboxEntry({
      signalId: 'fresh',
      taskId: 't',
      kind: 'completion_ready',
      createdAt: '2026-07-25T11:00:00.000Z',
    });
    const stale = buildSignalOutboxEntry({
      signalId: 'stale',
      taskId: 't',
      kind: 'completion_ready',
      createdAt: '2026-07-20T11:00:00.000Z',
    });
    const { kept, pruned } = boundSignalOutbox([stale, fresh], {
      now,
      maxAgeMs: DEFAULT_SIGNAL_OUTBOX_MAX_AGE_MS,
    });
    expect(pruned).toBe(1);
    expect(kept.map((e) => e.signalId)).toEqual(['fresh']);
  });

  test('drops oldest when over maxEntries', () => {
    const entries = Array.from({ length: 5 }, (_, i) => buildSignalOutboxEntry({
      signalId: `s${i}`,
      taskId: 't',
      kind: 'completion_ready',
      createdAt: new Date(Date.UTC(2026, 6, 25, 10, i)).toISOString(),
    }));
    const { kept, pruned } = boundSignalOutbox(entries, { maxEntries: 3, maxAgeMs: 1e15 });
    expect(pruned).toBe(2);
    expect(kept.map((e) => e.signalId)).toEqual(['s2', 's3', 's4']);
  });

  test('append enforces maxEntries and prefers keeping the new entry', async () => {
    const spoolDir = await tempSpoolDir();
    for (let i = 0; i < 3; i++) {
      await appendSignalOutbox(
        spoolDir,
        buildSignalOutboxEntry({
          signalId: `old-${i}`,
          taskId: 't',
          kind: 'completion_ready',
          createdAt: new Date(Date.UTC(2026, 6, 25, 10, i)).toISOString(),
        }),
        { maxEntries: 3, maxAgeMs: 1e15 },
      );
    }
    const result = await appendSignalOutbox(
      spoolDir,
      buildSignalOutboxEntry({
        signalId: 'new',
        taskId: 't',
        kind: 'completion_ready',
        createdAt: new Date(Date.UTC(2026, 6, 25, 11, 0)).toISOString(),
      }),
      { maxEntries: 3, maxAgeMs: 1e15 },
    );
    expect(result.appended).toBe(true);
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    const pending = await readPendingSignals(spoolDir);
    expect(pending).toHaveLength(3);
    expect(pending.some((e) => e.signalId === 'new')).toBe(true);
    expect(pending.some((e) => e.signalId === 'old-0')).toBe(false);
  });

  test('default max entries is the documented cap', () => {
    expect(DEFAULT_SIGNAL_OUTBOX_MAX_ENTRIES).toBe(200);
    expect(DEFAULT_SIGNAL_OUTBOX_MAX_AGE_MS).toBe(48 * 60 * 60 * 1000);
  });
});
