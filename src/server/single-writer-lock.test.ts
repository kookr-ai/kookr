import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireSingleWriterLock } from './single-writer-lock.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kookr-swl-'));
}

function readLock(dir: string): unknown {
  const raw = readFileSync(join(dir, 'server.pid'), 'utf8');
  const newline = raw.indexOf('\n');
  const record = JSON.parse(raw.slice(newline + 1).trim()) as { pid?: unknown };
  expect(record.pid).toBe(Number(raw.slice(0, newline)));
  return record;
}

function writeJsonLock(
  dir: string,
  record: { pid: number; processStartTimeMs: number; acquisitionId: string },
): void {
  writeFileSync(
    join(dir, 'server.pid'),
    `${record.pid}\n${JSON.stringify({ version: 2, ...record })}\n`,
  );
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for child-process lock state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function spawnLockContender(dir: string, gatePath: string, label: string) {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/server/single-writer-lock.ts')).href;
  const source = `
    import { existsSync } from 'node:fs';
    import { acquireSingleWriterLock } from ${JSON.stringify(moduleUrl)};
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    process.stdout.write(${JSON.stringify(`READY:${label}\n`)});
    while (!existsSync(${JSON.stringify(gatePath)})) sleep(5);
    try {
      const release = acquireSingleWriterLock(${JSON.stringify(dir)}, { retryMs: 0 });
      process.stdout.write(${JSON.stringify(`ACQUIRED:${label}\n`)});
      sleep(10_000);
      release();
    } catch (error) {
      process.stderr.write(String(error instanceof Error ? error.message : error));
      process.exitCode = 2;
    }
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('acquireSingleWriterLock (RFC R27)', () => {
  it('acquires with process and acquisition identity, then releases', () => {
    const dir = tempDir();
    const release = acquireSingleWriterLock(dir, {
      readProcessStartTimeMs: () => 1_765_000_000_123,
      createAcquisitionId: () => 'acquisition-one',
    });
    const lockPath = join(dir, 'server.pid');
    expect(Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)).toBe(process.pid);
    expect(readLock(dir)).toEqual({
      version: 2,
      pid: process.pid,
      processStartTimeMs: 1_765_000_000_123,
      acquisitionId: 'acquisition-one',
    });
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails closed without our process identity and leaves no ownership behind', () => {
    const dir = tempDir();
    expect(() => acquireSingleWriterLock(dir, {
      readProcessStartTimeMs: () => null,
    })).toThrow(new RegExp(`cannot determine this process identity \\(pid ${process.pid}\\)`));
    expect(existsSync(join(dir, 'server.pid'))).toBe(false);
    expect(existsSync(join(dir, 'server.lock.sqlite'))).toBe(false);

    const release = acquireSingleWriterLock(dir, {
      readProcessStartTimeMs: () => 2_000,
    });
    release();
  });

  it('fails closed for a matching same-process record not acquired locally', () => {
    const dir = tempDir();
    writeJsonLock(dir, {
      pid: process.pid,
      processStartTimeMs: 1_765_000_000_123,
      acquisitionId: 'unknown-acquisition',
    });
    expect(() => acquireSingleWriterLock(dir, {
      retryMs: 0,
      readProcessStartTimeMs: () => 1_765_000_000_123,
    })).toThrow(new RegExp(`another Kookr server \\(pid ${process.pid}\\)`));
  });

  it('fails closed when a live foreign PID has the matching process identity', () => {
    const dir = tempDir();
    writeJsonLock(dir, {
      pid: 424_242,
      processStartTimeMs: 1_765_000_000_123,
      acquisitionId: 'prior-acquisition',
    });
    expect(() => acquireSingleWriterLock(dir, {
      retryMs: 0,
      isAlive: () => true,
      readProcessStartTimeMs: (pid) => pid === process.pid ? 2_000 : 1_765_000_000_123,
    })).toThrow(/another Kookr server \(pid 424242\)/);
  });

  it('reclaims a live recycled PID whose process identity no longer matches', () => {
    const dir = tempDir();
    writeJsonLock(dir, {
      pid: 424_242,
      processStartTimeMs: 1_765_000_000_123,
      acquisitionId: 'prior-acquisition',
    });
    const release = acquireSingleWriterLock(dir, {
      retryMs: 0,
      isAlive: () => true,
      readProcessStartTimeMs: (pid) => pid === process.pid ? 2_000 : 1_765_999_999_999,
      createAcquisitionId: () => 'replacement-acquisition',
    });
    expect(readLock(dir)).toMatchObject({
      pid: process.pid,
      processStartTimeMs: 2_000,
      acquisitionId: 'replacement-acquisition',
    });
    release();
  });

  it('fails closed when a live holder process identity cannot be read', () => {
    const dir = tempDir();
    writeJsonLock(dir, {
      pid: 424_242,
      processStartTimeMs: 1_765_000_000_123,
      acquisitionId: 'prior-acquisition',
    });
    expect(() => acquireSingleWriterLock(dir, {
      retryMs: 0,
      isAlive: () => true,
      readProcessStartTimeMs: (pid) => pid === process.pid ? 2_000 : null,
    })).toThrow(/another Kookr server \(pid 424242\)/);
  });

  it('keeps a legacy live PID-only lock fail-closed', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'server.pid'), '424242\n');
    expect(() => acquireSingleWriterLock(dir, {
      retryMs: 0,
      isAlive: () => true,
      readProcessStartTimeMs: () => 2_000,
    })).toThrow(/another Kookr server \(pid 424242\)/);
  });

  it('takes over a legacy stale lock held by a dead pid', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'server.pid'), '999999999\n');
    const release = acquireSingleWriterLock(dir, {
      isAlive: () => false,
      readProcessStartTimeMs: () => 2_000,
    });
    expect(readLock(dir)).toMatchObject({ pid: process.pid, processStartTimeMs: 2_000 });
    release();
  });

  it('keeps an unreadable lock fail-closed', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'server.pid'), 'not-a-pid\n');
    expect(() => acquireSingleWriterLock(dir, {
      retryMs: 0,
      readProcessStartTimeMs: () => 2_000,
    })).toThrow(/cannot verify the owner/);
    expect(readFileSync(join(dir, 'server.pid'), 'utf8')).toBe('not-a-pid\n');
  });

  it('release is a no-op when the acquisition identity changed', () => {
    const dir = tempDir();
    const release = acquireSingleWriterLock(dir, {
      readProcessStartTimeMs: () => 2_000,
      createAcquisitionId: () => 'our-acquisition',
    });
    writeJsonLock(dir, {
      pid: process.pid,
      processStartTimeMs: 2_000,
      acquisitionId: 'replacement-acquisition',
    });
    release();
    expect(readLock(dir)).toMatchObject({ acquisitionId: 'replacement-acquisition' });
  });

  it('serializes synchronized processes and releases the mutex after SIGKILL', async () => {
    const dir = tempDir();
    const gatePath = join(dir, 'start-contenders');
    writeFileSync(join(dir, 'server.pid'), '999999999\n');
    const first = spawnLockContender(dir, gatePath, 'first');
    const second = spawnLockContender(dir, gatePath, 'second');
    let firstOut = '';
    let secondOut = '';
    let firstErr = '';
    let secondErr = '';
    first.stdout.on('data', (chunk) => { firstOut += String(chunk); });
    second.stdout.on('data', (chunk) => { secondOut += String(chunk); });
    first.stderr.on('data', (chunk) => { firstErr += String(chunk); });
    second.stderr.on('data', (chunk) => { secondErr += String(chunk); });
    const firstExit = new Promise<number | null>((resolve) => first.once('close', resolve));
    const secondExit = new Promise<number | null>((resolve) => second.once('close', resolve));

    try {
      await waitFor(() => firstOut.includes('READY:first') && secondOut.includes('READY:second'));
      writeFileSync(gatePath, 'go\n');
      await waitFor(() => firstOut.includes('ACQUIRED:first') || secondOut.includes('ACQUIRED:second'));

      const firstWon = firstOut.includes('ACQUIRED:first');
      const winner = firstWon ? first : second;
      const loserExit = firstWon ? secondExit : firstExit;
      const loserError = () => firstWon ? secondErr : firstErr;
      expect(await loserExit).toBe(2);
      expect(loserError()).toMatch(/another Kookr server/);
      expect(Number(firstOut.includes('ACQUIRED:first')) + Number(secondOut.includes('ACQUIRED:second'))).toBe(1);

      winner.kill('SIGKILL');
      expect(await (firstWon ? firstExit : secondExit)).not.toBe(0);

      const release = acquireSingleWriterLock(dir, { retryMs: 1_000 });
      expect(readLock(dir)).toMatchObject({ pid: process.pid });
      release();
    } finally {
      first.kill('SIGKILL');
      second.kill('SIGKILL');
    }
  }, 15_000);

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
      readProcessStartTimeMs: () => 2_000,
    });
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(readLock(dir)).toMatchObject({ pid: process.pid });
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
      readProcessStartTimeMs: () => 2_000,
    })).toThrow(/another Kookr server \(pid 1\)/);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it('takes over a real child pid without mocking liveness (issue #2501)', async () => {
    const dir = tempDir();
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
      expect(readLock(dir)).toMatchObject({ pid: process.pid });
      release();
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });
});
