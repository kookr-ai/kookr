import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  configureKbPreflightProbeForTests,
  resetKbPreflightCacheForTests,
  runLaunchDependencyPreflights,
} from './launch-dependency-runner.js';

const PROBE_TIMEOUT_MS = 250;
const CLEANUP_GRACE_MS = 50;
const CACHE_TTL_MS = 80;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await wait(10);
  }
  return !pidAlive(pid);
}

function writeKbStub(dir: string): void {
  const kbPath = join(dir, 'kb');
  const modeFile = join(dir, 'mode');
  const pidFile = join(dir, 'pid');
  const startsFile = join(dir, 'starts');
  writeFileSync(modeFile, 'hang\n');
  writeFileSync(startsFile, '');
  writeFileSync(kbPath, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const modeFile = ${JSON.stringify(modeFile)};
const pidFile = ${JSON.stringify(pidFile)};
const startsFile = ${JSON.stringify(startsFile)};
fs.appendFileSync(startsFile, String(process.pid) + '\\n');
const mode = fs.readFileSync(modeFile, 'utf8').trim();
if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(pidFile, String(process.pid));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === 'doctor') {
  process.stdout.write(JSON.stringify({
    status: 'ok',
    checks: [{ name: 'backend', status: 'ok', detail: 'reachable' }],
  }));
  process.exit(0);
} else {
  process.stdout.write(JSON.stringify({ results: [] }));
  process.exit(0);
}
`);
  chmodSync(kbPath, 0o755);
}

describe('launch dependency runner SIGTERM-ignoring child (issue #3223)', () => {
  let tempDir: string | undefined;
  let previousPath: string | undefined;

  beforeEach(() => {
    previousPath = process.env.PATH;
    resetKbPreflightCacheForTests();
    configureKbPreflightProbeForTests({
      timeoutMs: PROBE_TIMEOUT_MS,
      cleanupGraceMs: CLEANUP_GRACE_MS,
      cacheTtlMs: CACHE_TTL_MS,
    });
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-dep-probe-sigterm-'));
    writeKbStub(tempDir);
    process.env.PATH = `${tempDir}${delimiter}${previousPath ?? ''}`;
  });

  afterEach(() => {
    const pidPath = tempDir ? join(tempDir, 'pid') : undefined;
    if (pidPath) {
      try {
        const pid = Number(readFileSync(pidPath, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 1 && pidAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Test-owned leftover; ignore if already gone.
          }
        }
      } catch {
        // No pid file — the stub never started or already exited.
      }
    }
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    resetKbPreflightCacheForTests();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test('a SIGTERM-ignoring kb yields unknown health and is reaped', async () => {
    const started = Date.now();
    const findings = await runLaunchDependencyPreflights(['kb']);
    const elapsed = Date.now() - started;

    expect(findings).toEqual([
      expect.objectContaining({ dependency: 'kb', category: 'unknown' }),
    ]);
    expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS + CLEANUP_GRACE_MS + 400);

    const pid = Number(readFileSync(join(tempDir!, 'pid'), 'utf8').trim());
    expect(pid).toBeGreaterThan(1);
    expect(await waitForPidExit(pid, CLEANUP_GRACE_MS + 400)).toBe(true);
  });

  test('concurrent callers share one hanging child and all settle', async () => {
    const [first, second] = await Promise.all([
      runLaunchDependencyPreflights(['kb']),
      runLaunchDependencyPreflights(['kb']),
    ]);

    expect(first).toEqual(second);
    expect(first[0]).toEqual(expect.objectContaining({ category: 'unknown' }));

    const starts = readFileSync(join(tempDir!, 'starts'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(starts).toHaveLength(1);

    const pid = Number(starts[0]);
    expect(await waitForPidExit(pid, CLEANUP_GRACE_MS + 400)).toBe(true);
  });

  test('a later call can probe successfully once the cache expires', async () => {
    const first = await runLaunchDependencyPreflights(['kb']);
    expect(first[0]).toEqual(expect.objectContaining({ category: 'unknown' }));

    const pid = Number(readFileSync(join(tempDir!, 'pid'), 'utf8').trim());
    expect(await waitForPidExit(pid, CLEANUP_GRACE_MS + 400)).toBe(true);

    writeFileSync(join(tempDir!, 'mode'), 'ok\n');
    await wait(CACHE_TTL_MS + 20);

    await expect(runLaunchDependencyPreflights(['kb'])).resolves.toEqual([]);
  });
});
