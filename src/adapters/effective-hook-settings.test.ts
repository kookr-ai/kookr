import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  effectiveHookSettingsPath,
  readPersistedHookSettings,
} from './effective-hook-settings.js';

describe('effectiveHookSettingsPath', () => {
  const settingsDir = '/home/u/.kookr/settings';

  it('returns a path under settingsDir for a safe session id', () => {
    const path = effectiveHookSettingsPath(settingsDir, 'kookr-abc_123');
    expect(path).toBe(join(settingsDir, 'kookr-abc_123.json'));
    // Stay strictly under the settings directory (no traversal, no absolute rewrite).
    expect(resolve(path!).startsWith(resolve(settingsDir) + '/')).toBe(true);
  });

  it.each([
    { label: 'dot-dot traversal', id: '../etc/passwd' },
    { label: 'leading slash absolute-looking', id: '/etc/passwd' },
    { label: 'absolute with drive-like colon', id: 'C:Windows' },
    { label: 'dot segment', id: '.' },
    { label: 'double-dot alone', id: '..' },
    { label: 'slash in middle', id: 'a/b' },
    { label: 'backslash', id: 'a\\b' },
    { label: 'space', id: 'has space' },
    { label: 'null-ish tilde', id: '~root' },
    { label: 'empty string', id: '' },
    { label: 'over length cap (129)', id: 'a'.repeat(129) },
  ])('rejects unsafe session id ($label)', ({ id }) => {
    expect(effectiveHookSettingsPath(settingsDir, id)).toBeUndefined();
  });

  it('accepts the max-length safe id (128 chars)', () => {
    const id = 'a'.repeat(128);
    expect(effectiveHookSettingsPath(settingsDir, id)).toBe(join(settingsDir, `${id}.json`));
  });
});

describe('readPersistedHookSettings', () => {
  let settingsDir: string;

  function setupDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'kookr-ehs-'));
    const dir = join(root, 'settings');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('loads and parses valid JSON for a safe id', () => {
    settingsDir = setupDir();
    try {
      const payload = { hooks: { SessionStart: [] } };
      writeFileSync(join(settingsDir, 'kookr-safe.json'), JSON.stringify(payload));
      expect(readPersistedHookSettings(settingsDir, 'kookr-safe')).toEqual(payload);
    } finally {
      rmSync(settingsDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when the file is missing', () => {
    settingsDir = setupDir();
    try {
      expect(readPersistedHookSettings(settingsDir, 'nope')).toBeUndefined();
    } finally {
      rmSync(settingsDir, { recursive: true, force: true });
    }
  });

  it('degrades malformed JSON to undefined without throwing', () => {
    settingsDir = setupDir();
    try {
      writeFileSync(join(settingsDir, 'kookr-bad.json'), '{not-json');
      expect(() => readPersistedHookSettings(settingsDir, 'kookr-bad')).not.toThrow();
      expect(readPersistedHookSettings(settingsDir, 'kookr-bad')).toBeUndefined();
    } finally {
      rmSync(settingsDir, { recursive: true, force: true });
    }
  });

  it('never reads outside settingsDir for traversal-looking ids', () => {
    settingsDir = setupDir();
    try {
      // Plant a file that would be hit if join(settingsDir, '../escape.json') were used.
      const escapePath = join(settingsDir, '..', 'escape.json');
      writeFileSync(escapePath, JSON.stringify({ leaked: true }));
      expect(existsSync(escapePath)).toBe(true);

      // Unsafe ids must short-circuit before any filesystem read.
      expect(readPersistedHookSettings(settingsDir, '../escape')).toBeUndefined();
      expect(readPersistedHookSettings(settingsDir, '..')).toBeUndefined();
      expect(readPersistedHookSettings(settingsDir, '/escape')).toBeUndefined();
    } finally {
      rmSync(join(settingsDir, '..'), { recursive: true, force: true });
    }
  });
});
