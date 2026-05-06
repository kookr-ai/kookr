import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadSettings, saveSettings, validateSettings, DEFAULT_SETTINGS } from './settings-store.js';

describe('validateSettings', () => {
  it('returns defaults for empty object', () => {
    expect(validateSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('accepts valid boolean for githubPollingEnabled', () => {
    expect(validateSettings({ githubPollingEnabled: false })).toEqual({
      ...DEFAULT_SETTINGS,
      githubPollingEnabled: false,
    });
  });

  it('falls back to default for non-boolean githubPollingEnabled', () => {
    expect(validateSettings({ githubPollingEnabled: 'yes' })).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps interval below minimum to 15', () => {
    expect(validateSettings({ githubPollingIntervalSec: 5 })).toEqual({
      ...DEFAULT_SETTINGS,
      githubPollingIntervalSec: 15,
    });
  });

  it('clamps interval above maximum to 600', () => {
    expect(validateSettings({ githubPollingIntervalSec: 9999 })).toEqual({
      ...DEFAULT_SETTINGS,
      githubPollingIntervalSec: 600,
    });
  });

  it('rounds fractional interval', () => {
    expect(validateSettings({ githubPollingIntervalSec: 45.7 })).toEqual({
      ...DEFAULT_SETTINGS,
      githubPollingIntervalSec: 46,
    });
  });

  it('ignores non-number interval', () => {
    expect(validateSettings({ githubPollingIntervalSec: 'fast' })).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores NaN and Infinity', () => {
    expect(validateSettings({ githubPollingIntervalSec: NaN })).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings({ githubPollingIntervalSec: Infinity })).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps watchdogStaleThresholdSec below minimum to 15', () => {
    expect(validateSettings({ watchdogStaleThresholdSec: 5 }).watchdogStaleThresholdSec).toBe(15);
  });

  it('clamps watchdogStaleThresholdSec above maximum to 90', () => {
    expect(validateSettings({ watchdogStaleThresholdSec: 200 }).watchdogStaleThresholdSec).toBe(90);
  });

  it('rounds fractional watchdogStaleThresholdSec', () => {
    expect(validateSettings({ watchdogStaleThresholdSec: 45.7 }).watchdogStaleThresholdSec).toBe(46);
  });

  it('clamps repeatedErrorThreshold below minimum to 2', () => {
    expect(validateSettings({ repeatedErrorThreshold: 0 }).repeatedErrorThreshold).toBe(2);
  });

  it('clamps repeatedErrorThreshold above maximum to 10', () => {
    expect(validateSettings({ repeatedErrorThreshold: 50 }).repeatedErrorThreshold).toBe(10);
  });

  it('clamps maxActiveTasks below minimum to 1', () => {
    expect(validateSettings({ maxActiveTasks: 0 }).maxActiveTasks).toBe(1);
  });

  it('clamps maxActiveTasks above maximum to 25', () => {
    expect(validateSettings({ maxActiveTasks: 100 }).maxActiveTasks).toBe(25);
  });

  it('fills missing new fields with defaults', () => {
    const result = validateSettings({ githubPollingEnabled: false, githubPollingIntervalSec: 120 });
    expect(result.autoWatchOssSources).toBe(true);
    expect(result.watchdogStaleThresholdSec).toBe(30);
    expect(result.repeatedErrorThreshold).toBe(3);
    expect(result.maxActiveTasks).toBe(10);
  });

  it('accepts valid boolean for autoWatchOssSources', () => {
    expect(validateSettings({ autoWatchOssSources: false })).toEqual({
      ...DEFAULT_SETTINGS,
      autoWatchOssSources: false,
    });
  });
});

describe('loadSettings / saveSettings', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when file does not exist', async () => {
    const result = await loadSettings(join(tmpDir, 'nonexistent.json'));
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.loadedFromDefaults).toBe(true);
  });

  it('returns defaults for corrupt JSON', async () => {
    const filePath = join(tmpDir, 'settings.json');
    await writeFile(filePath, '{ invalid json', 'utf-8');
    const result = await loadSettings(filePath);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.loadedFromDefaults).toBe(true);
  });

  it('returns defaults for JSON array', async () => {
    const filePath = join(tmpDir, 'settings.json');
    await writeFile(filePath, '[1, 2, 3]', 'utf-8');
    const result = await loadSettings(filePath);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.loadedFromDefaults).toBe(true);
  });

  it('round-trips valid settings', async () => {
    const filePath = join(tmpDir, 'settings.json');
    const settings = {
      githubPollingEnabled: false,
      githubPollingIntervalSec: 120,
      autoWatchOssSources: false,
      watchdogStaleThresholdSec: 45,
      repeatedErrorThreshold: 5,
      maxActiveTasks: 15,
    };
    await saveSettings(filePath, settings);
    const result = await loadSettings(filePath);
    expect(result.settings).toEqual(settings);
    expect(result.loadedFromDefaults).toBe(false);
  });

  it('saves as pretty JSON', async () => {
    const filePath = join(tmpDir, 'settings.json');
    await saveSettings(filePath, DEFAULT_SETTINGS);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('\n');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('validates on load — clamps out-of-range values', async () => {
    const filePath = join(tmpDir, 'settings.json');
    await writeFile(filePath, JSON.stringify({ githubPollingIntervalSec: 3 }), 'utf-8');
    const result = await loadSettings(filePath);
    expect(result.settings.githubPollingIntervalSec).toBe(15);
    expect(result.settings.githubPollingEnabled).toBe(true); // default
  });

  it('fills missing new fields with defaults on load', async () => {
    const filePath = join(tmpDir, 'settings.json');
    // Old-format file with only github fields
    await writeFile(filePath, JSON.stringify({
      githubPollingEnabled: false,
      githubPollingIntervalSec: 120,
    }), 'utf-8');
    const result = await loadSettings(filePath);
    expect(result.settings.watchdogStaleThresholdSec).toBe(30);
    expect(result.settings.repeatedErrorThreshold).toBe(3);
    expect(result.settings.autoWatchOssSources).toBe(true);
    expect(result.settings.maxActiveTasks).toBe(10);
    expect(result.loadedFromDefaults).toBe(false);
  });

  it('atomic write: temp file does not persist on success', async () => {
    const filePath = join(tmpDir, 'settings.json');
    await saveSettings(filePath, DEFAULT_SETTINGS);

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(tmpDir);
    expect(files).toEqual(['settings.json']);
    expect(files).not.toContain('settings.json.tmp');
  });
});
