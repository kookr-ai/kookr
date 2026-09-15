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
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_SERVER_LOG_GENERATIONS,
  DEFAULT_SERVER_LOG_MAX_BYTES,
  DEFAULT_SERVER_LOG_ROTATE_INTERVAL_MS,
  MAX_LIVE_LOG_RECOVERY_ATTEMPTS_PER_TICK,
  MAX_ROTATION_ERROR_LENGTH,
  ServerLogRotationHealth,
  ServerLogRotationRecovery,
  clearPendingServerLogRecovery,
  maybeRotateServerLog,
  reopenProcessStdio,
  resolveServerLogRotationEnv,
  rotateServerLogGenerations,
  runScheduledServerLogRotation,
  type ServerLogRotationResult,
} from './server-log-rotation.js';

function throwEnospc(): never {
  const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
  err.code = 'ENOSPC';
  throw err;
}

/**
 * Worktrees often lack node_modules. Resolve tsx from a PATH entry that
 * already points at a checkout's `node_modules/.bin` (where `pnpm exec` found
 * vitest).
 */
function resolveTsxLoader(): string {
  for (const binDir of (process.env.PATH ?? '').split(':')) {
    if (!binDir.endsWith(`${join('node_modules', '.bin')}`)) continue;
    try {
      const loader = createRequire(join(dirname(dirname(binDir)), 'package.json')).resolve('tsx');
      return pathToFileURL(loader).href;
    } catch {
      // try the next PATH entry
    }
  }
  throw new Error('unable to resolve tsx loader for redirected-child import');
}

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
    clearPendingServerLogRecovery();
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
    expect(result.pendingReopen).toBeFalsy();
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

describe('pending live-log recovery (issue #3176)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-server-log-recover-'));
    logPath = join(dir, 'server.log');
  });

  afterEach(() => {
    clearPendingServerLogRecovery();
    rmSync(dir, { recursive: true, force: true });
  });

  test('later tick recreates the live file after ENOSPC without shifting generations again', () => {
    writeFileSync(logPath, 'live-content-long-enough\n');
    writeFileSync(`${logPath}.1`, 'prev-gen\n');

    let failOpen = true;
    const reopen = vi.fn((path: string) => {
      if (failOpen) throwEnospc();
      writeFileSync(path, '');
    });
    const openSyncFn = (path: string, flags: string) => {
      if (failOpen && path === logPath) throwEnospc();
      return openSync(path, flags);
    };
    const recovery = new ServerLogRotationRecovery();
    const config = {
      logPath,
      maxBytes: 5,
      generations: 3,
      stdioOwnsLog: () => true,
      reopenStdioFn: reopen,
      openSyncFn,
      recovery,
    };

    const first = maybeRotateServerLog(config);
    expect(first.rotated).toBe(true);
    expect(first.pendingReopen).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('live-content-long-enough\n');
    expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('prev-gen\n');

    failOpen = false;
    const second = maybeRotateServerLog({
      ...config,
      stdioOwnsLog: () => false,
    });

    expect(second.rotated).toBe(false);
    expect(second.recovered).toBe(true);
    expect(second.pendingReopen).toBeFalsy();
    expect(recovery.peek(logPath)).toBeNull();
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('live-content-long-enough\n');
    expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('prev-gen\n');
    expect(existsSync(`${logPath}.3`)).toBe(false);
    appendFileSync(logPath, 'after-recovery\n');
    expect(readFileSync(logPath, 'utf8')).toContain('after-recovery\n');

    writeFileSync(logPath, 'live-again-long-enough-to-rotate\n');
    const third = maybeRotateServerLog({
      ...config,
      stdioOwnsLog: () => true,
    });
    expect(third.rotated).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('live-again-long-enough-to-rotate\n');
  });

  test('pending state authorizes reopen when the live file was recreated but stdio is unattached', () => {
    writeFileSync(logPath, 'owned-live-long-enough\n');
    const recovery = new ServerLogRotationRecovery();
    let allowReopen = false;
    const reopen = vi.fn((path: string) => {
      if (!allowReopen) throwEnospc();
      if (!existsSync(path)) writeFileSync(path, '');
    });
    const openSyncFn = (path: string, flags: string) => {
      if (path === logPath && !existsSync(path)) throwEnospc();
      return openSync(path, flags);
    };

    const first = maybeRotateServerLog({
      logPath,
      maxBytes: 5,
      generations: 2,
      stdioOwnsLog: () => true,
      reopenStdioFn: reopen,
      openSyncFn,
      recovery,
    });
    expect(first.pendingReopen).toBe(true);
    expect(existsSync(logPath)).toBe(false);

    writeFileSync(logPath, 'external-recreate\n');
    allowReopen = true;
    reopen.mockClear();

    const second = maybeRotateServerLog({
      logPath,
      maxBytes: 5,
      generations: 2,
      stdioOwnsLog: () => false,
      reopenStdioFn: reopen,
      openSyncFn: (path, flags) => openSync(path, flags),
      recovery,
    });

    expect(second.recovered).toBe(true);
    expect(second.rotated).toBe(false);
    expect(reopen).toHaveBeenCalledWith(logPath);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('owned-live-long-enough\n');
    expect(readFileSync(logPath, 'utf8')).toContain('external-recreate');
  });

  test('never-owned missing file is still skipped with no descriptor hijacking', () => {
    const reopen = vi.fn();
    const recovery = new ServerLogRotationRecovery();
    const result = maybeRotateServerLog({
      logPath,
      maxBytes: 10,
      generations: 3,
      stdioOwnsLog: () => true,
      reopenStdioFn: reopen,
      recovery,
    });
    expect(result).toMatchObject({ rotated: false, skippedReason: 'missing' });
    expect(result.pendingReopen).toBeFalsy();
    expect(reopen).not.toHaveBeenCalled();
  });

  test('journald/TTY stdout is still skipped and does not enter pending recovery', () => {
    writeFileSync(logPath, 'old-content-that-is-long-enough\n');
    const reopen = vi.fn();
    const recovery = new ServerLogRotationRecovery();
    const first = maybeRotateServerLog({
      logPath,
      maxBytes: 10,
      generations: 3,
      stdioOwnsLog: () => false,
      reopenStdioFn: reopen,
      recovery,
    });
    expect(first).toMatchObject({ rotated: false, skippedReason: 'stdio-not-attached' });
    expect(first.pendingReopen).toBeFalsy();

    const second = maybeRotateServerLog({
      logPath,
      maxBytes: 10,
      generations: 3,
      stdioOwnsLog: () => false,
      reopenStdioFn: reopen,
      recovery,
    });
    expect(second).toMatchObject({ rotated: false, skippedReason: 'stdio-not-attached' });
    expect(reopen).not.toHaveBeenCalled();
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  test('runScheduledServerLogRotation retries pending reopen on a later tick', () => {
    writeFileSync(logPath, 'live-content-long-enough\n');
    writeFileSync(`${logPath}.1`, 'prev-gen\n');
    const recovery = new ServerLogRotationRecovery();
    let failOpen = true;
    const reopen = vi.fn((path: string) => {
      if (failOpen) throwEnospc();
      writeFileSync(path, '');
    });
    const openSyncFn = (path: string, flags: string) => {
      if (failOpen && path === logPath) throwEnospc();
      return openSync(path, flags);
    };
    const config = {
      logPath,
      maxBytes: 5,
      generations: 3,
      stdioOwnsLog: () => true,
      reopenStdioFn: reopen,
      openSyncFn,
      recovery,
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const first = runScheduledServerLogRotation(config);
    expect(first.pendingReopen).toBe(true);
    failOpen = false;
    const second = runScheduledServerLogRotation({ ...config, stdioOwnsLog: () => false });
    expect(second.recovered).toBe(true);
    expect(second.rotated).toBe(false);
    expect(existsSync(logPath)).toBe(true);
    expect(recovery.peek(logPath)).toBeNull();
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('live-content-long-enough\n');
    expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('prev-gen\n');

    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('recovery attempts on a later tick stay bounded', () => {
    writeFileSync(logPath, 'live-content-long-enough\n');
    const recovery = new ServerLogRotationRecovery();
    const reopen = vi.fn(() => {
      throwEnospc();
    });
    // Per attach: ensure open succeeds (odd call) so the second reopen runs;
    // fallback open fails (even call) so pending remains and the cap is hit.
    let liveOpens = 0;
    const openSyncFn = (path: string, flags: string) => {
      if (path !== logPath) return openSync(path, flags);
      liveOpens += 1;
      if (liveOpens % 2 === 1) return openSync(path, flags);
      throwEnospc();
    };
    const config = {
      logPath,
      maxBytes: 5,
      generations: 2,
      stdioOwnsLog: () => true,
      reopenStdioFn: reopen,
      openSyncFn,
      recovery,
    };

    const first = maybeRotateServerLog(config);
    expect(first.pendingReopen).toBe(true);
    expect(first.recoveryAttempts).toBe(MAX_LIVE_LOG_RECOVERY_ATTEMPTS_PER_TICK);
    expect(reopen).toHaveBeenCalledTimes(MAX_LIVE_LOG_RECOVERY_ATTEMPTS_PER_TICK);
    reopen.mockClear();

    const second = maybeRotateServerLog({ ...config, stdioOwnsLog: () => false });
    expect(second.pendingReopen).toBe(true);
    expect(second.recovered).toBeFalsy();
    expect(second.recoveryAttempts).toBe(MAX_LIVE_LOG_RECOVERY_ATTEMPTS_PER_TICK);
    expect(reopen).toHaveBeenCalledTimes(MAX_LIVE_LOG_RECOVERY_ATTEMPTS_PER_TICK);
  });

  test('pending recovery for one path does not authorize reopen of a different missing log', () => {
    writeFileSync(logPath, 'owned-live-long-enough\n');
    const recovery = new ServerLogRotationRecovery();
    const reopen = vi.fn(() => {
      throwEnospc();
    });
    const openSyncFn = (path: string, flags: string) => {
      if (path === logPath) throwEnospc();
      return openSync(path, flags);
    };

    expect(
      maybeRotateServerLog({
        logPath,
        maxBytes: 5,
        generations: 2,
        stdioOwnsLog: () => true,
        reopenStdioFn: reopen,
        openSyncFn,
        recovery,
      }).pendingReopen,
    ).toBe(true);

    const other = join(dir, 'other.log');
    const otherReopen = vi.fn();
    const otherResult = maybeRotateServerLog({
      logPath: other,
      maxBytes: 5,
      generations: 2,
      stdioOwnsLog: () => true,
      reopenStdioFn: otherReopen,
      recovery,
    });
    expect(otherResult).toMatchObject({ rotated: false, skippedReason: 'missing' });
    expect(otherReopen).not.toHaveBeenCalled();
    expect(recovery.peek(logPath)).not.toBeNull();
  });

  test('redirected child restores logging on a later tick after ENOSPC on live open', () => {
    const harness = join(dir, 'recover-harness.mjs');
    const live = join(dir, 'server.log');
    const rotationSrc = fileURLToPath(new URL('./server-log-rotation.ts', import.meta.url));
    writeFileSync(live, 'BEFORE_SEED_LONG_ENOUGH\n');
    writeFileSync(`${live}.1`, 'PREV_GEN\n');
    writeFileSync(
      harness,
      `
import { readFileSync, writeFileSync, existsSync, openSync as realOpenSync } from 'node:fs';
import { maybeRotateServerLog } from ${JSON.stringify(rotationSrc)};

const logPath = process.argv[2];
let denyLiveOpen = true;
const openSyncFn = (path, flags) => {
  if (denyLiveOpen && path === logPath) {
    const err = new Error('ENOSPC: no space left on device');
    err.code = 'ENOSPC';
    throw err;
  }
  return realOpenSync(path, flags);
};

const config = { logPath, maxBytes: 5, generations: 3, openSyncFn };
try {
  const first = maybeRotateServerLog(config);
  denyLiveOpen = false;
  const second = maybeRotateServerLog(config);
  process.stdout.write('AFTER_RECOVERY\\n');
  writeFileSync(logPath + '.ok', JSON.stringify({
    firstPending: first.pendingReopen === true,
    firstRotated: first.rotated === true,
    secondRecovered: second.recovered === true,
    secondRotated: second.rotated === true,
    live: existsSync(logPath) ? readFileSync(logPath, 'utf8') : null,
    gen1: readFileSync(logPath + '.1', 'utf8'),
    gen2: readFileSync(logPath + '.2', 'utf8'),
    gen3: existsSync(logPath + '.3'),
  }));
} catch (err) {
  writeFileSync(logPath + '.err', String(err && err.stack ? err.stack : err));
  throw err;
}
`,
    );

    const outFd = openSync(live, 'a');
    const errFd = openSync(live, 'a');
    try {
      const result = spawnSync(process.execPath, ['--import', resolveTsxLoader(), harness, live], {
        encoding: 'utf8',
        stdio: ['ignore', outFd, errFd],
      });
      const childErr = existsSync(`${live}.err`) ? readFileSync(`${live}.err`, 'utf8') : '';
      expect(result.status, childErr || result.stderr || result.stdout || 'child failed').toBe(0);
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }

    const payload = JSON.parse(readFileSync(`${live}.ok`, 'utf8')) as {
      firstPending: boolean;
      firstRotated: boolean;
      secondRecovered: boolean;
      secondRotated: boolean;
      live: string | null;
      gen1: string;
      gen2: string;
      gen3: boolean;
    };
    expect(payload.firstRotated).toBe(true);
    expect(payload.firstPending).toBe(true);
    expect(payload.secondRecovered).toBe(true);
    expect(payload.secondRotated).toBe(false);
    expect(payload.gen1).toMatch(/BEFORE_SEED/);
    expect(payload.gen2).toBe('PREV_GEN\n');
    expect(payload.gen3).toBe(false);
    expect(payload.live).toMatch(/AFTER_RECOVERY/);
    expect(payload.live).not.toMatch(/BEFORE_SEED/);
  });
});

describe('reopenProcessStdio export', () => {
  test('is a callable freopen helper', () => {
    expect(typeof reopenProcessStdio).toBe('function');
  });
});

describe('ServerLogRotationHealth (issue #3113)', () => {
  test('starts empty before any tick', () => {
    const health = new ServerLogRotationHealth();
    expect(health.getHealthSnapshot()).toEqual({
      schemaVersion: 'server-log-rotation.v1',
      lastRotationAt: null,
      lastRotationError: null,
      lastSkippedReason: null,
    });
  });

  test('retains the error message and skip reason from a failing tick', () => {
    let nowMs = 1_700_000_000_000;
    const health = new ServerLogRotationHealth(() => nowMs);
    const failing: ServerLogRotationResult = {
      rotated: false,
      previousSize: 60 * 1024 * 1024,
      skippedReason: 'error',
      error: "ENOSPC: no space left on device, rename '/data/kookr/server.log'",
    };

    health.record(failing);

    expect(health.getHealthSnapshot()).toEqual({
      schemaVersion: 'server-log-rotation.v1',
      lastRotationAt: new Date(nowMs).toISOString(),
      lastRotationError: "ENOSPC: no space left on device, rename '/data/kookr/server.log'",
      lastSkippedReason: 'error',
    });
  });

  test('retains a non-error skip reason (stdio-not-attached) with no error', () => {
    const health = new ServerLogRotationHealth();
    health.record({ rotated: false, previousSize: 99, skippedReason: 'stdio-not-attached' });
    const snap = health.getHealthSnapshot();
    expect(snap.lastSkippedReason).toBe('stdio-not-attached');
    expect(snap.lastRotationError).toBeNull();
    expect(snap.lastRotationAt).not.toBeNull();
  });

  test('a successful rotation clears a previously recorded error', () => {
    const health = new ServerLogRotationHealth();
    health.record({
      rotated: false,
      previousSize: 60 * 1024 * 1024,
      skippedReason: 'error',
      error: 'EACCES: permission denied',
    });
    expect(health.getHealthSnapshot().lastRotationError).toBe('EACCES: permission denied');

    health.record({ rotated: true, previousSize: 60 * 1024 * 1024 });

    expect(health.getHealthSnapshot()).toMatchObject({
      lastRotationError: null,
      lastSkippedReason: null,
    });
  });

  test('surfaces a post-rename freopen warning while still marking rotated', () => {
    const health = new ServerLogRotationHealth();
    health.record({
      rotated: true,
      previousSize: 60 * 1024 * 1024,
      error: 'freopen failed after rename: expected freopen stdout fd 1, got 5',
    });
    expect(health.getHealthSnapshot().lastRotationError).toMatch(/freopen failed after rename/);
  });

  test('bounds the retained error message length', () => {
    const health = new ServerLogRotationHealth();
    health.record({ rotated: false, previousSize: 1, skippedReason: 'error', error: 'x'.repeat(5_000) });
    // Assert the exact prefix-slice, not just the length: a mutant that
    // truncated from the wrong end or substituted characters would still be
    // the right length.
    expect(health.getHealthSnapshot().lastRotationError).toBe('x'.repeat(MAX_ROTATION_ERROR_LENGTH));
  });

  test('records the observable fields from a real rotation failure result', () => {
    // Drive the real routine into its error path (rename throws) and feed the
    // returned result to health — the same wiring the rotation tick uses.
    const health = new ServerLogRotationHealth();
    const result = maybeRotateServerLog({
      logPath: '/data/kookr/server.log',
      maxBytes: 1,
      generations: 2,
      reopenStdio: false,
      statSize: () => {
        throw new Error('EACCES: permission denied, stat');
      },
    });

    expect(result.rotated).toBe(false);
    expect(result.skippedReason).toBe('error');
    health.record(result);
    const snap = health.getHealthSnapshot();
    expect(snap.lastSkippedReason).toBe('error');
    expect(snap.lastRotationError).toBeTruthy();
    expect(snap.lastRotationAt).not.toBeNull();
  });
});
