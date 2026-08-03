import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_SERVER_LOG_GENERATIONS,
  DEFAULT_SERVER_LOG_MAX_BYTES,
  DEFAULT_SERVER_LOG_ROTATE_INTERVAL_MS,
  maybeRotateServerLog,
  reopenProcessStdio,
  resolveServerLogRotationEnv,
  rotateServerLogGenerations,
  runScheduledServerLogRotation,
} from './server-log-rotation.js';

describe('resolveServerLogRotationEnv', () => {
  test('applies documented defaults', () => {
    const resolved = resolveServerLogRotationEnv({}, '/data/kookr');
    expect(resolved).toEqual({
      logPath: join('/data/kookr', 'server.log'),
      maxBytes: DEFAULT_SERVER_LOG_MAX_BYTES,
      generations: DEFAULT_SERVER_LOG_GENERATIONS,
      intervalMs: DEFAULT_SERVER_LOG_ROTATE_INTERVAL_MS,
    });
  });

  test('parses overrides and clamps generations', () => {
    const resolved = resolveServerLogRotationEnv(
      {
        KOOKR_SERVER_LOG_MAX_BYTES: '1024',
        KOOKR_LOG_GENERATIONS: '250',
        KOOKR_SERVER_LOG_ROTATE_INTERVAL_MS: '5000',
      },
      '/tmp/data',
    );
    expect(resolved.maxBytes).toBe(1024);
    expect(resolved.generations).toBe(100);
    expect(resolved.intervalMs).toBe(5000);
  });

  test('zero maxBytes, generations, or interval disables the feature knobs', () => {
    expect(
      resolveServerLogRotationEnv({ KOOKR_SERVER_LOG_MAX_BYTES: '0' }, '/d').maxBytes,
    ).toBe(0);
    expect(
      resolveServerLogRotationEnv({ KOOKR_LOG_GENERATIONS: '0' }, '/d').generations,
    ).toBe(0);
    expect(
      resolveServerLogRotationEnv({ KOOKR_SERVER_LOG_ROTATE_INTERVAL_MS: '0' }, '/d').intervalMs,
    ).toBe(0);
  });
});

describe('rotateServerLogGenerations / maybeRotateServerLog', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-server-log-rot-'));
    logPath = join(dir, 'server.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('when log exceeds threshold, rotation produces .1 and a fresh live file', () => {
    writeFileSync(logPath, 'old-content-that-is-long-enough\n');
    const reopen = vi.fn((path: string) => {
      writeFileSync(path, '');
    });

    const result = maybeRotateServerLog({
      logPath,
      maxBytes: 10,
      generations: 3,
      stdioOwnsLog: () => true,
      reopenStdioFn: reopen,
    });

    expect(result.rotated).toBe(true);
    expect(result.previousSize).toBeGreaterThan(10);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('old-content-that-is-long-enough\n');
    expect(readFileSync(logPath, 'utf8')).toBe('');
    expect(reopen).toHaveBeenCalledWith(logPath);
  });

  test('skips rotation when stdout is not attached to server.log (no journald/TTY steal)', () => {
    writeFileSync(logPath, 'old-content-that-is-long-enough\n');
    const reopen = vi.fn();
    const result = maybeRotateServerLog({
      logPath,
      maxBytes: 10,
      generations: 3,
      stdioOwnsLog: () => false,
      reopenStdioFn: reopen,
    });
    expect(result).toMatchObject({ rotated: false, skippedReason: 'stdio-not-attached' });
    expect(reopen).not.toHaveBeenCalled();
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(readFileSync(logPath, 'utf8')).toBe('old-content-that-is-long-enough\n');
  });

  test('freopen failure after rename still reports rotated and leaves a live file', () => {
    writeFileSync(logPath, 'before-rotation-long\n');
    let attempts = 0;
    const result = maybeRotateServerLog({
      logPath,
      maxBytes: 5,
      generations: 2,
      stdioOwnsLog: () => true,
      reopenStdioFn: () => {
        attempts += 1;
        throw new Error('freopen boom');
      },
    });
    expect(result.rotated).toBe(true);
    expect(result.error).toMatch(/freopen/i);
    expect(attempts).toBe(2); // initial + one retry
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('before-rotation-long\n');
    expect(existsSync(logPath)).toBe(true);
    // Live path is writable after recovery ensureLiveLogExists
    appendFileSync(logPath, 'after\n');
    expect(readFileSync(logPath, 'utf8')).toContain('after\n');
  });

  test('does not rotate when under threshold', () => {
    writeFileSync(logPath, 'tiny\n');
    const result = maybeRotateServerLog({
      logPath,
      maxBytes: 10_000,
      generations: 3,
      reopenStdio: false,
    });
    expect(result).toMatchObject({ rotated: false, skippedReason: 'under-threshold' });
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  test('missing live log is a no-op', () => {
    const result = maybeRotateServerLog({
      logPath,
      maxBytes: 10,
      generations: 3,
      reopenStdio: false,
    });
    expect(result).toMatchObject({ rotated: false, skippedReason: 'missing' });
  });

  test('shifts generations and drops the oldest beyond retention', () => {
    writeFileSync(logPath, 'live\n');
    writeFileSync(`${logPath}.1`, 'gen1\n');
    writeFileSync(`${logPath}.2`, 'gen2\n');
    writeFileSync(`${logPath}.3`, 'gen3-should-drop\n');

    rotateServerLogGenerations(logPath, 2);

    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('live\n');
    expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('gen1\n');
    expect(existsSync(`${logPath}.3`)).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });

  test('no lost writes: append after reopen lands on the fresh file', () => {
    writeFileSync(logPath, 'before-rotation\n');

    const result = maybeRotateServerLog({
      logPath,
      maxBytes: 5,
      generations: 2,
      stdioOwnsLog: () => true,
      reopenStdioFn: (path) => {
        writeFileSync(path, '');
      },
    });
    expect(result.rotated).toBe(true);

    // Subsequent append (as freopen'd stdio would) goes to the new live file.
    appendFileSync(logPath, 'after-rotation\n');

    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('before-rotation\n');
    expect(readFileSync(logPath, 'utf8')).toBe('after-rotation\n');
  });

  test('runScheduledServerLogRotation logs errors without throwing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = runScheduledServerLogRotation({
      logPath,
      maxBytes: 1,
      generations: 1,
      statSize: () => {
        throw new Error('stat boom');
      },
    });
    expect(result.rotated).toBe(false);
    expect(result.skippedReason).toBe('error');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('reopenProcessStdio in a redirected child: post-rotate writes land on the fresh file', () => {
    // Real freopen in a subprocess so we never touch the vitest runner's FDs.
    const harness = join(dir, 'harness.mjs');
    const live = join(dir, 'live.log');
    writeFileSync(live, 'BEFORE_SEED_LONG_ENOUGH\n');
    writeFileSync(
      harness,
      `
import {
  renameSync, openSync, closeSync, writeSync, readFileSync, writeFileSync, unlinkSync, statSync,
} from 'node:fs';

const logPath = process.argv[2];
const maxBytes = Number(process.argv[3]);

function rotate(path, generations) {
  for (let i = generations; i <= 100; i++) {
    try { unlinkSync(path + '.' + i); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  for (let g = generations - 1; g >= 1; g--) {
    try { renameSync(path + '.' + g, path + '.' + (g + 1)); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  renameSync(path, path + '.1');
}

function freopen(path) {
  closeSync(1);
  const fd1 = openSync(path, 'a');
  if (fd1 !== 1) throw new Error('stdout fd ' + fd1);
  closeSync(2);
  const fd2 = openSync(path, 'a');
  if (fd2 !== 2) throw new Error('stderr fd ' + fd2);
}

process.stdout.write('BEFORE\\n');
if (statSync(logPath).size > maxBytes) {
  rotate(logPath, 2);
  freopen(logPath);
  process.stdout.write('AFTER\\n');
  writeSync(1, 'RAW_AFTER\\n');
}
writeFileSync(logPath + '.ok', JSON.stringify({
  live: readFileSync(logPath, 'utf8'),
  gen: readFileSync(logPath + '.1', 'utf8'),
}));
`,
    );

    const outFd = openSync(live, 'a');
    const errFd = openSync(live, 'a');
    try {
      const result = spawnSync(process.execPath, [harness, live, '5'], {
        encoding: 'utf8',
        stdio: ['ignore', outFd, errFd],
      });
      expect(result.status, result.stderr || result.stdout || 'child failed').toBe(0);
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }

    const payload = JSON.parse(readFileSync(`${live}.ok`, 'utf8')) as {
      live: string;
      gen: string;
    };
    expect(payload.gen).toMatch(/BEFORE/);
    expect(payload.live).toMatch(/AFTER/);
    expect(payload.live).not.toMatch(/BEFORE_SEED/);
  });
});

describe('reopenProcessStdio export', () => {
  test('is a callable freopen helper', () => {
    expect(typeof reopenProcessStdio).toBe('function');
  });
});
