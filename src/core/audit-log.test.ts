import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendAuditRow,
  DEFAULT_AUDIT_LOG_MAX_BYTES,
  DEFAULT_AUDIT_LOG_ROTATED_GENERATIONS,
} from './audit-log.js';

describe('appendAuditRow', () => {
  let tempDir: string;
  let auditPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-audit-log-'));
    auditPath = join(tempDir, 'nested', 'audit.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('exports conservative default rotation thresholds', () => {
    expect(DEFAULT_AUDIT_LOG_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(DEFAULT_AUDIT_LOG_ROTATED_GENERATIONS).toBe(2);
  });

  test('no-ops when auditLogPath is undefined', async () => {
    await expect(appendAuditRow(undefined, { type: 'noop' })).resolves.toBeUndefined();
  });

  test('creates parent directory and appends a JSON line', async () => {
    await appendAuditRow(auditPath, { type: 'task.deleteTask', id: 'a' });

    expect(readFileSync(auditPath, 'utf-8')).toBe(
      `${JSON.stringify({ type: 'task.deleteTask', id: 'a' })}\n`,
    );
    expect(existsSync(`${auditPath}.1`)).toBe(false);
  });

  test('appends multiple rows without rotating while under maxBytes', async () => {
    await appendAuditRow(auditPath, { n: 1 });
    await appendAuditRow(auditPath, { n: 2 });
    await appendAuditRow(auditPath, { n: 3 });

    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ n: 1 });
    expect(JSON.parse(lines[2]!)).toEqual({ n: 3 });
    expect(existsSync(`${auditPath}.1`)).toBe(false);
  });

  test('rotates audit.jsonl when an append would exceed maxBytes', async () => {
    // Fixed-width pad so each line is exactly 20 bytes ("{\"gen\":\"X\",\"p\":\"..\"}\\n").
    // maxBytes=20 → every append after the first rotates.
    const opts = { maxBytes: 20, rotatedGenerations: 2 };
    await appendAuditRow(auditPath, { gen: 'a', p: '..' }, opts); // 20 bytes
    await appendAuditRow(auditPath, { gen: 'b', p: '..' }, opts); // would exceed → rotate
    await appendAuditRow(auditPath, { gen: 'c', p: '..' }, opts); // rotate again

    expect(readFileSync(auditPath, 'utf-8')).toBe(`${JSON.stringify({ gen: 'c', p: '..' })}\n`);
    expect(readFileSync(`${auditPath}.1`, 'utf-8')).toBe(`${JSON.stringify({ gen: 'b', p: '..' })}\n`);
  });

  test('retains two rotated generations and drops older ones', async () => {
    // Each line is 20 bytes; maxBytes 20 forces a rotate on every append after the first.
    const opts = { maxBytes: 20, rotatedGenerations: DEFAULT_AUDIT_LOG_ROTATED_GENERATIONS };
    await appendAuditRow(auditPath, { gen: 'a', p: '..' }, opts);
    await appendAuditRow(auditPath, { gen: 'b', p: '..' }, opts); // → .1=a, current=b
    await appendAuditRow(auditPath, { gen: 'c', p: '..' }, opts); // → .1=b, .2=a, current=c
    await appendAuditRow(auditPath, { gen: 'd', p: '..' }, opts); // → .1=c, .2=b, a dropped

    expect(readFileSync(auditPath, 'utf-8')).toBe(`${JSON.stringify({ gen: 'd', p: '..' })}\n`);
    expect(readFileSync(`${auditPath}.1`, 'utf-8')).toBe(`${JSON.stringify({ gen: 'c', p: '..' })}\n`);
    expect(readFileSync(`${auditPath}.2`, 'utf-8')).toBe(`${JSON.stringify({ gen: 'b', p: '..' })}\n`);
    expect(existsSync(`${auditPath}.3`)).toBe(false);
  });

  test('never throws when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = vi.fn();
    // Parent path is a file, so mkdir/append fails.
    const blocker = join(tempDir, 'not-a-dir');
    writeFileSync(blocker, 'file');
    const badPath = join(blocker, 'audit.jsonl');

    await expect(
      appendAuditRow(badPath, { type: 'should-fail' }, { onError }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[audit-log] failed to append audit row:',
      expect.anything(),
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.anything());
  });

  test('keeps the no-throw contract when a failure observer throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocker = join(tempDir, 'not-a-dir');
    writeFileSync(blocker, 'file');
    const badPath = join(blocker, 'audit.jsonl');

    await expect(
      appendAuditRow(badPath, { type: 'should-fail' }, {
        onError: () => { throw new Error('observer failed'); },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[audit-log] failure observer threw:',
      expect.objectContaining({ message: 'observer failed' }),
    );
  });

  test('never throws when the destination is not writable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = join(tempDir, 'ro');
    mkdirSync(dir);
    const path = join(dir, 'audit.jsonl');
    writeFileSync(path, '');
    chmodSync(path, 0o444);
    chmodSync(dir, 0o555);

    await expect(appendAuditRow(path, { type: 'ro-fail' })).resolves.toBeUndefined();

    // Restore perms so afterEach cleanup can remove the tree.
    chmodSync(dir, 0o755);
    chmodSync(path, 0o644);

    expect(warn).toHaveBeenCalled();
  });
});
