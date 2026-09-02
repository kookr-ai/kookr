import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';

// The ESM namespace of node:fs/promises isn't configurable, so we can't spyOn
// its exports. Instead mock the module once and drive the parent-directory
// fsync's behavior (opened with flag 'r') from this hoisted, mutable state.
// Temp-file opens (flag 'w') pass through untouched.
const dirSyncControl = vi.hoisted(() => ({
  // Errno to inject for the directory handle (flag 'r'). null = no failure.
  failureCode: null as string | null,
  // When true, the failure is raised by open(dir,'r') itself (outer branch);
  // when false, it's raised by handle.sync() (inner branch).
  failOnOpen: false,
  paths: [] as string[],
  // Ordered log of durability-relevant fs ops, so a test can prove the
  // parent-directory fsync runs AFTER the rename (running it before would
  // defeat the crash-durability guarantee this feature exists for).
  order: [] as string[],
  // Invocation counts for the directory handle so tests can prove the fsync
  // actually ran (not silently skipped) and its fd was released (no fd leak).
  dirSyncCount: 0,
  dirCloseCount: 0,
}));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      dirSyncControl.order.push('rename');
      return actual.rename(from, to);
    }),
    open: vi.fn(async (path: string, flags?: string | number, mode?: number) => {
      if (flags === 'r') {
        dirSyncControl.paths.push(String(path));
        dirSyncControl.order.push('dir-open');
        if (dirSyncControl.failureCode !== null && dirSyncControl.failOnOpen) {
          const err = new Error('mock directory open failure') as NodeJS.ErrnoException;
          err.code = dirSyncControl.failureCode;
          throw err;
        }
      }
      const handle = await actual.open(path, flags as never, mode);
      if (flags === 'r') {
        const realSync = handle.sync.bind(handle);
        const realClose = handle.close.bind(handle);
        const code = dirSyncControl.failureCode;
        handle.sync = async () => {
          dirSyncControl.dirSyncCount += 1;
          if (code !== null) {
            const err = new Error('mock directory fsync failure') as NodeJS.ErrnoException;
            err.code = code;
            throw err;
          }
          return realSync();
        };
        handle.close = async () => {
          dirSyncControl.dirCloseCount += 1;
          return realClose();
        };
      }
      return handle;
    }),
  };
});

describe('atomicWriteFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-atomic-write-'));
    dirSyncControl.failureCode = null;
    dirSyncControl.failOnOpen = false;
    dirSyncControl.paths = [];
    dirSyncControl.order = [];
    dirSyncControl.dirSyncCount = 0;
    dirSyncControl.dirCloseCount = 0;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('applies optional mode so secret callers can force 0o600', async () => {
    const filePath = join(tempDir, 'secret.json');
    await atomicWriteFile(filePath, '{"ok":true}', { mode: 0o600 });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":true}');
  });

  test('fchmod forces requested mode bits despite a restrictive umask', async () => {
    // 0o077 would strip group bits from open(mode=0o640) → 0o600 without fchmod.
    const previousUmask = process.umask(0o077);
    try {
      const filePath = join(tempDir, 'group-readable.json');
      await atomicWriteFile(filePath, '{"ok":true}', { mode: 0o640 });
      expect(statSync(filePath).mode & 0o777).toBe(0o640);
    } finally {
      process.umask(previousUmask);
    }
  });

  test('default path keeps non-secret world-readable-by-umask behavior', async () => {
    const filePath = join(tempDir, 'public.json');
    await atomicWriteFile(filePath, '{"ok":true}');
    // Default open mode is 0o666 masked by umask; with a typical 0o022 umask
    // the result is 0o644. Assert we did *not* force owner-only.
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).not.toBe(0o600);
    expect(mode & 0o400).toBe(0o400); // owner-readable at minimum
  });

  test('removes the temporary file when the final rename fails', async () => {
    const filePath = join(tempDir, 'target.json');
    // A directory at the final path makes rename() fail after the temporary
    // file has been written, which is the failure window that used to leak it.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(filePath);

    await expect(atomicWriteFile(filePath, '{"ok":true}')).rejects.toThrow();
    expect(readdirSync(tempDir).filter((entry) => entry.startsWith('.tmp-'))).toEqual([]);
  });

  test('fsyncs the parent directory after the rename on success', async () => {
    const filePath = join(tempDir, 'durable.json');

    await atomicWriteFile(filePath, '{"ok":true}');

    // The parent directory was opened exactly once (no duplicate fsync) and its
    // fsync ran strictly AFTER the rename — the ordering that makes the renamed
    // entry durable. The handle was synced once and then closed (no fd leak).
    expect(dirSyncControl.paths).toEqual([tempDir]);
    expect(dirSyncControl.order).toEqual(['rename', 'dir-open']);
    expect(dirSyncControl.dirSyncCount).toBe(1);
    expect(dirSyncControl.dirCloseCount).toBe(1);
    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":true}');
  });

  test('tolerates an unsupported directory fsync (EINVAL) as a successful write', async () => {
    dirSyncControl.failureCode = 'EINVAL';
    const filePath = join(tempDir, 'nofsyncdir.json');

    // Filesystems that reject fsync on a directory fd must not fail the write.
    await expect(atomicWriteFile(filePath, '{"ok":true}')).resolves.toBeUndefined();
    expect(dirSyncControl.paths).toContain(tempDir);
    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":true}');
  });

  test('surfaces a genuine directory fsync failure while leaving the file visible', async () => {
    dirSyncControl.failureCode = 'EIO';
    const filePath = join(tempDir, 'ambiguous.json');

    // A real I/O error on the directory fsync is ambiguous: the rename already
    // made the file visible, so we reject (documenting the durability gap) but
    // the new contents are already on the final path.
    await expect(atomicWriteFile(filePath, '{"ok":true}')).rejects.toThrow(/parent[\s\S]*directory/i);
    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":true}');
    expect(readdirSync(tempDir).filter((entry) => entry.startsWith('.tmp-'))).toEqual([]);
    // The directory handle is still closed on the failure branch (the finally),
    // so a failing fsync doesn't leak the fd.
    expect(dirSyncControl.dirCloseCount).toBe(1);
  });

  test('tolerates an unsupported failure opening the directory (EACCES) as success', async () => {
    // The durability fsync must also open the directory; a filesystem/platform
    // that won't let us open it read-only (EACCES) is treated as unsupported,
    // not as a write failure. Exercises fsyncDirectory's open() branch.
    dirSyncControl.failureCode = 'EACCES';
    dirSyncControl.failOnOpen = true;
    const filePath = join(tempDir, 'noopendir.json');

    await expect(atomicWriteFile(filePath, '{"ok":true}')).resolves.toBeUndefined();
    expect(dirSyncControl.paths).toContain(tempDir);
    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":true}');
  });

  test('surfaces a genuine failure opening the directory while leaving the file visible', async () => {
    // A genuine I/O error opening the directory (EIO, not in the unsupported
    // set) is surfaced, but the rename already made the file visible.
    dirSyncControl.failureCode = 'EIO';
    dirSyncControl.failOnOpen = true;
    const filePath = join(tempDir, 'openfail.json');

    const error = await atomicWriteFile(filePath, '{"ok":true}').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBe('EIO');
    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":true}');
  });

  test('wraps the underlying directory fsync error as the cause', async () => {
    dirSyncControl.failureCode = 'EIO';
    const filePath = join(tempDir, 'cause.json');

    const error = await atomicWriteFile(filePath, '{"ok":true}').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBe('EIO');
  });
});

describe('readJsonFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-persistence-utils-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('quarantines corrupt JSON and warns before returning fallback', async () => {
    const filePath = join(tempDir, 'settings.json');
    const corruptContents = '{"truncated":';
    writeFileSync(filePath, corruptContents);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await readJsonFile(filePath, { ok: false }, {
      quarantineCorrupt: true,
      warningPrefix: 'test-store',
    });

    expect(result).toEqual({ ok: false });
    expect(existsSync(filePath)).toBe(false);
    const quarantined = readdirSync(tempDir).filter((entry) => entry.startsWith('settings.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(tempDir, quarantined[0]), 'utf-8')).toBe(corruptContents);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[test-store] Corrupt JSON file'),
      expect.any(SyntaxError),
    );
    expect(warn.mock.calls[0][0]).toContain(filePath);
    expect(warn.mock.calls[0][0]).toContain(join(tempDir, quarantined[0]));
  });

  test('does not overwrite an existing quarantine file for the same timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const filePath = join(tempDir, 'settings.json');
    const existingQuarantine = `${filePath}.corrupt-2026-01-01T00:00:00.000Z`;
    writeFileSync(existingQuarantine, 'previous corrupt copy');
    writeFileSync(filePath, '{"new":');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await readJsonFile(filePath, { ok: false }, {
      quarantineCorrupt: true,
      warningPrefix: 'test-store',
    });

    expect(result).toEqual({ ok: false });
    expect(readFileSync(existingQuarantine, 'utf-8')).toBe('previous corrupt copy');
    expect(readFileSync(`${existingQuarantine}-1`, 'utf-8')).toBe('{"new":');
  });

  test('missing file returns fallback silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filePath = join(tempDir, 'missing.json');

    const result = await readJsonFile(filePath, ['fallback'], {
      quarantineCorrupt: true,
      warningPrefix: 'test-store',
    });

    expect(result).toEqual(['fallback']);
    expect(warn).not.toHaveBeenCalled();
    expect(readdirSync(tempDir)).toEqual([]);
  });

  test('valid JSON loads normally without warning or quarantine', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filePath = join(tempDir, 'settings.json');
    writeFileSync(filePath, JSON.stringify({ ok: true }));

    const result = await readJsonFile(filePath, { ok: false }, {
      quarantineCorrupt: true,
      warningPrefix: 'test-store',
    });

    expect(result).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
    expect(readdirSync(tempDir)).toEqual(['settings.json']);
  });
});
