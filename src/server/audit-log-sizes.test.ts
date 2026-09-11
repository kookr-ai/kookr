import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectAuditLogSizes, statCommandAuditLogSizes } from './audit-log-sizes.js';

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-audit-log-sizes-'));
}

describe('statCommandAuditLogSizes (issue #3158)', () => {
  test('reports null active bytes and zeroed archives for an absent data directory', async () => {
    const missing = join(tmpdir(), `kookr-audit-sizes-missing-${Date.now()}`);
    expect(await statCommandAuditLogSizes(missing)).toEqual({
      activeBytes: null,
      archiveCount: 0,
      archiveBytes: 0,
    });
  });

  test('reports the active audit.jsonl byte size when present', async () => {
    const dir = await makeDir();
    try {
      const payload = 'x'.repeat(128);
      await writeFile(join(dir, 'audit.jsonl'), payload, 'utf8');

      const sizes = await statCommandAuditLogSizes(dir);
      expect(sizes.activeBytes).toBe(Buffer.byteLength(payload));
      expect(sizes.archiveCount).toBe(0);
      expect(sizes.archiveBytes).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('totals archives when the active audit.jsonl is absent but rotated segments remain', async () => {
    const dir = await makeDir();
    try {
      // Active log rotated/deleted away while archives linger — activeBytes is
      // null yet the archive-scanning loop must still run and total them.
      await writeFile(join(dir, 'audit.2026-03-01T00-00-00.000Z.9.1.jsonl'), 'p'.repeat(12), 'utf8');
      await writeFile(join(dir, 'audit.2026-03-02T00-00-00.000Z.9.2.jsonl'), 'q'.repeat(8), 'utf8');

      const sizes = await statCommandAuditLogSizes(dir);
      expect(sizes.activeBytes).toBeNull();
      expect(sizes.archiveCount).toBe(2);
      expect(sizes.archiveBytes).toBe(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('counts rotated audit.*.jsonl archives and totals their bytes, ignoring the snapshot', async () => {
    const dir = await makeDir();
    try {
      await writeFile(join(dir, 'audit.jsonl'), 'active\n', 'utf8');
      // The snapshot sidecar (audit.snapshot.json) must not be counted as an archive.
      await writeFile(join(dir, 'audit.snapshot.json'), '{}\n', 'utf8');
      await writeFile(join(dir, 'audit.2026-01-01T00-00-00.000Z.123.1.jsonl'), 'a'.repeat(10), 'utf8');
      await writeFile(join(dir, 'audit.2026-01-02T00-00-00.000Z.123.2.jsonl'), 'b'.repeat(15), 'utf8');

      const [a1, a2] = await Promise.all([
        stat(join(dir, 'audit.2026-01-01T00-00-00.000Z.123.1.jsonl')),
        stat(join(dir, 'audit.2026-01-02T00-00-00.000Z.123.2.jsonl')),
      ]);
      const sizes = await statCommandAuditLogSizes(dir);
      expect(sizes.activeBytes).toBe(Buffer.byteLength('active\n'));
      expect(sizes.archiveCount).toBe(2);
      expect(sizes.archiveBytes).toBe(a1.size + a2.size);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('collectAuditLogSizes (issue #3158)', () => {
  test('degrades to nulls / zeros when both logs are absent', async () => {
    const dir = await makeDir();
    try {
      expect(await collectAuditLogSizes(dir)).toEqual({
        commandAudit: { activeBytes: null, archiveCount: 0, archiveBytes: 0 },
        collaborationAudit: { activeBytes: null },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reports both logs when present', async () => {
    const dir = await makeDir();
    try {
      await writeFile(join(dir, 'audit.jsonl'), 'x'.repeat(40), 'utf8');
      await writeFile(join(dir, 'audit.2026-01-01T00-00-00.000Z.1.1.jsonl'), 'y'.repeat(10), 'utf8');
      await writeFile(join(dir, 'collaboration-audit.jsonl'), 'c'.repeat(25), 'utf8');

      expect(await collectAuditLogSizes(dir)).toEqual({
        commandAudit: { activeBytes: 40, archiveCount: 1, archiveBytes: 10 },
        collaborationAudit: { activeBytes: 25 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
