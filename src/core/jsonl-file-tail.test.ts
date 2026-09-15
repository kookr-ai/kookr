import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JSONL_LOG_READ_MAX_BYTES, readJsonlLogTail } from './jsonl-file-tail.js';

describe('readJsonlLogTail', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-jsonl-tail-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns empty array for a missing file', async () => {
    expect(await readJsonlLogTail(join(tempDir, 'missing.jsonl'))).toEqual([]);
  });

  test('reads a file under the cap in full', async () => {
    const path = join(tempDir, 'small.jsonl');
    const event = { type: 'ping', n: 1 };
    writeFileSync(path, `${JSON.stringify(event)}\n`);
    expect(await readJsonlLogTail(path)).toEqual([event]);
  });

  test('drops a parseable only-line truncated window', async () => {
    const path = join(tempDir, 'only-line.jsonl');
    const dropped = JSON.stringify({ type: 'finding_skipped', marker: 'DROPPED_PARTIAL' });
    const maxBytes = dropped.length + 1;
    const prefix = `${JSON.stringify({ type: 'aged' })}\n${'x'.repeat(maxBytes)}GARBAGE`;
    writeFileSync(path, `${prefix}${dropped}\n`);
    expect(statSync(path).size).toBeGreaterThan(maxBytes);
    expect(await readJsonlLogTail(path, maxBytes)).toEqual([]);
  });

  test('default cap is 256 KiB', () => {
    expect(JSONL_LOG_READ_MAX_BYTES).toBe(256 * 1024);
  });
});
