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

describe('atomicWriteFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-atomic-write-'));
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
