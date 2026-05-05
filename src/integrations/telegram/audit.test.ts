import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAuditWriter } from './audit.js';

function readKinds(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
}

describe('createAuditWriter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes rapid audit writes in call order', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kookr-tg-audit-'));
    const path = join(tmp, 'telegram', 'audit.jsonl');
    try {
      const audit = await createAuditWriter(path);
      for (let i = 0; i < 25; i++) {
        audit({ kind: 'message_received', sender: i, text: `message-${i}`, len: 9 });
      }

      await audit.flush();
      expect(readKinds(path)).toEqual(Array.from({ length: 25 }, () => 'message_received'));
      const senders = readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { sender: number }).sender);
      expect(senders).toEqual(Array.from({ length: 25 }, (_, i) => i));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('continues writing after an append failure', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kookr-tg-audit-'));
    const path = join(tmp, 'telegram', 'audit.jsonl');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const audit = await createAuditWriter(path);
      audit({ kind: 'start', allowedUserCount: 1, allowedProjectCount: 1, dryRun: false });
      await audit.flush();

      rmSync(dirname(path), { recursive: true, force: true });
      audit({ kind: 'help_replied', sender: 1 });
      await audit.flush();
      expect(stderr.mock.calls.some(([msg]) => String(msg).includes('[telegram-audit] append failed'))).toBe(true);

      mkdirSync(dirname(path), { recursive: true });
      audit({ kind: 'message_received', sender: 2, text: 'after failure', len: 13 });
      await audit.flush();
      expect(readKinds(path)).toEqual(['message_received']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('drops new events after close while preserving queued writes', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kookr-tg-audit-'));
    const path = join(tmp, 'telegram', 'audit.jsonl');
    try {
      const audit = await createAuditWriter(path);
      audit({ kind: 'start', allowedUserCount: 1, allowedProjectCount: 1, dryRun: false });
      await audit.close();
      audit({ kind: 'help_replied', sender: 1 });
      await audit.flush();

      expect(readKinds(path)).toEqual(['start']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
