import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSingleWriterLock } from './single-writer-lock.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kookr-swl-'));
}

describe('acquireSingleWriterLock (RFC R27)', () => {
  it('acquires, writes our pid, and releases on the returned fn', () => {
    const dir = tempDir();
    const release = acquireSingleWriterLock(dir);
    const lockPath = join(dir, 'server.pid');
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('re-acquire by the same process succeeds (own pid counts as stale-safe)', () => {
    const dir = tempDir();
    acquireSingleWriterLock(dir);
    // Same-pid holder: not "another server" — takeover path applies.
    const release2 = acquireSingleWriterLock(dir);
    release2();
  });

  it('fails loudly when a LIVE other process holds the lock', () => {
    const dir = tempDir();
    // PID 1 (init) is always alive and never ours.
    writeFileSync(join(dir, 'server.pid'), '1\n');
    expect(() => acquireSingleWriterLock(dir, { retryMs: 0 })).toThrow(/another Kookr server \(pid 1\)/);
  });

  it('takes over a stale lock held by a dead pid', () => {
    const dir = tempDir();
    // A pid that is (almost certainly) unused: max pid space boundary.
    writeFileSync(join(dir, 'server.pid'), '999999999\n');
    const release = acquireSingleWriterLock(dir);
    expect(readFileSync(join(dir, 'server.pid'), 'utf8').trim()).toBe(String(process.pid));
    release();
  });

  it('takes over an unreadable/garbage lock file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'server.pid'), 'not-a-pid\n');
    const release = acquireSingleWriterLock(dir);
    expect(readFileSync(join(dir, 'server.pid'), 'utf8').trim()).toBe(String(process.pid));
    release();
  });

  it('release is a no-op when another process re-took the lock', () => {
    const dir = tempDir();
    const release = acquireSingleWriterLock(dir);
    writeFileSync(join(dir, 'server.pid'), '1\n'); // simulate takeover
    release();
    expect(readFileSync(join(dir, 'server.pid'), 'utf8').trim()).toBe('1');
  });

  it('retries then takes over when the holder dies during the retry window (issue #2501)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'server.pid'), '424242\n');
    let holderAlive = true;
    const sleeps: number[] = [];
    const release = acquireSingleWriterLock(dir, {
      retryMs: 200,
      retryIntervalMs: 50,
      sleep: (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 2) holderAlive = false;
      },
      isAlive: () => holderAlive,
    });
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(dir, 'server.pid'), 'utf8').trim()).toBe(String(process.pid));
    release();
  });

  it('still fails after the retry window when another live process holds the lock', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'server.pid'), '1\n');
    const sleeps: number[] = [];
    expect(() => acquireSingleWriterLock(dir, {
      retryMs: 120,
      retryIntervalMs: 40,
      sleep: (ms) => { sleeps.push(ms); },
      isAlive: () => true,
    })).toThrow(/another Kookr server \(pid 1\)/);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it('takes over a real child pid without mocking liveness (issue #2501)', async () => {
    const dir = tempDir();
    const { spawn } = await import('node:child_process');
    // Short-lived child: acquire is synchronous (Atomics.wait), so a
    // setTimeout killer would never fire. The child exits on its own
    // during the retry window while we use the production isAlive probe.
    const child = spawn('sleep', ['0.2'], { stdio: 'ignore' });
    const childPid = child.pid;
    expect(childPid).toBeDefined();
    writeFileSync(join(dir, 'server.pid'), `${childPid}\n`);
    try {
      const release = acquireSingleWriterLock(dir, {
        retryMs: 1_500,
        retryIntervalMs: 40,
      });
      expect(readFileSync(join(dir, 'server.pid'), 'utf8').trim()).toBe(String(process.pid));
      release();
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });
});
