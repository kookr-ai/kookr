import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPathHealthChecker } from './local-path-health.js';

describe('LocalPathHealthChecker', () => {
  test('reports unknown paths as present and resolves missing after the async check', async () => {
    const checker = new LocalPathHealthChecker(60_000, async () => false);

    // First read: never checked → optimistic "present", check scheduled.
    expect(checker.isMissing('/tmp/gone/x')).toBe(false);
    await checker.settle();
    // Second read: stat landed → missing.
    expect(checker.isMissing('/tmp/gone/x')).toBe(true);
  });

  test('reports existing paths as present after the check', async () => {
    const checker = new LocalPathHealthChecker(60_000, async () => true);
    checker.isMissing('/srv/alive');
    await checker.settle();
    expect(checker.isMissing('/srv/alive')).toBe(false);
  });

  test('caches within the TTL and re-checks after it expires', async () => {
    let exists = false;
    let calls = 0;
    let now = 1_000_000;
    const checker = new LocalPathHealthChecker(
      60_000,
      async () => { calls += 1; return exists; },
      () => now,
    );

    checker.isMissing('/p');
    await checker.settle();
    expect(checker.isMissing('/p')).toBe(true);
    expect(checker.isMissing('/p')).toBe(true);
    await checker.settle();
    expect(calls).toBe(1); // fresh cache — no re-stat

    // Path comes back; TTL expires → re-check scheduled, stale answer served once.
    exists = true;
    now += 61_000;
    expect(checker.isMissing('/p')).toBe(true);
    await checker.settle();
    expect(checker.isMissing('/p')).toBe(false);
    expect(calls).toBe(2);
  });

  test('keeps the previous answer when the checker throws', async () => {
    let shouldThrow = false;
    let now = 1_000_000;
    const checker = new LocalPathHealthChecker(
      60_000,
      async () => {
        if (shouldThrow) throw new Error('EACCES');
        return true;
      },
      () => now,
    );
    checker.isMissing('/p');
    await checker.settle();
    expect(checker.isMissing('/p')).toBe(false);

    shouldThrow = true;
    now += 61_000;
    checker.isMissing('/p');
    await checker.settle();
    // Transient fs error must not flip the project to hidden.
    expect(checker.isMissing('/p')).toBe(false);
  });

  test('default fs-backed checker stats real paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lph-test-'));
    try {
      const checker = new LocalPathHealthChecker(60_000);
      checker.isMissing(dir);
      checker.isMissing(join(dir, 'does-not-exist'));
      await checker.settle();
      expect(checker.isMissing(dir)).toBe(false);
      expect(checker.isMissing(join(dir, 'does-not-exist'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
