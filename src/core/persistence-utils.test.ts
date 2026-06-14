import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile } from './persistence-utils.js';

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
