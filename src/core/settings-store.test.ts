import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadSettings, saveSettings, validateSettings, validateSettingsWithWarnings, DEFAULT_SETTINGS } from './settings-store.js';

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
    expect(result.defaultAgentType).toBe('claude-code');
    expect(result.shortcutBindings).toEqual({});
  });

  it('accepts valid boolean for autoWatchOssSources', () => {
    expect(validateSettings({ autoWatchOssSources: false })).toEqual({
      ...DEFAULT_SETTINGS,
      autoWatchOssSources: false,
    });
  });

  it('accepts valid defaultAgentType values', () => {
    expect(validateSettings({ defaultAgentType: 'codex-cli' })).toEqual({
      ...DEFAULT_SETTINGS,
      defaultAgentType: 'codex-cli',
    });
  });

  it('falls back to default for invalid defaultAgentType values', () => {
    expect(validateSettings({ defaultAgentType: 'gemini-cli' })).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings({ defaultAgentType: null })).toEqual(DEFAULT_SETTINGS);
  });

  it('accepts the round-robin defaultAgentType', () => {
    expect(validateSettings({ defaultAgentType: 'round-robin' })).toEqual({
      ...DEFAULT_SETTINGS,
      defaultAgentType: 'round-robin',
    });
  });

  it('defaults roundRobinIndex to 0', () => {
    expect(validateSettings({}).roundRobinIndex).toBe(0);
  });

  it('accepts a valid non-negative integer roundRobinIndex', () => {
    expect(validateSettings({ roundRobinIndex: 7 }).roundRobinIndex).toBe(7);
  });

  it('falls back to 0 for negative, fractional, or non-number roundRobinIndex', () => {
    expect(validateSettings({ roundRobinIndex: -3 }).roundRobinIndex).toBe(0);
    expect(validateSettings({ roundRobinIndex: 2.5 }).roundRobinIndex).toBe(0);
    expect(validateSettings({ roundRobinIndex: 'five' }).roundRobinIndex).toBe(0);
    expect(validateSettings({ roundRobinIndex: NaN }).roundRobinIndex).toBe(0);
  });

  it('validates shortcut binding overrides with warnings', () => {
    const result = validateSettingsWithWarnings({
      shortcutBindings: {
        mac: {
          next_bottleneck: 'Cmd+Ctrl+Space',
          quick_launch: 'Cmd+Ctrl+Space',
          nope: 'Ctrl+X',
          previous_task: 'Ctrl+N+K',
        },
      },
    });

    expect(result.settings.shortcutBindings).toEqual({
      mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
    });
    expect(result.warnings).toEqual([
      'Shortcut "quick_launch" in mac bindings conflicts with "next_bottleneck" on Cmd+Ctrl+Space; ignored',
      'Unknown shortcut action "nope" in mac bindings was ignored',
      'Shortcut "previous_task" in mac bindings has invalid binding "Ctrl+N+K"; ignored',
    ]);
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
    expect(result.warnings).toEqual([]);
  });

  it('returns defaults for corrupt JSON', async () => {
    const filePath = join(tmpDir, 'settings.json');
    await writeFile(filePath, '{ invalid json', 'utf-8');
    const result = await loadSettings(filePath);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.loadedFromDefaults).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('returns defaults for JSON array', async () => {
    const filePath = join(tmpDir, 'settings.json');
    await writeFile(filePath, '[1, 2, 3]', 'utf-8');
    const result = await loadSettings(filePath);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.loadedFromDefaults).toBe(true);
    expect(result.warnings).toEqual([]);
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
      defaultAgentType: 'codex-cli' as const,
      roundRobinIndex: 3,
      shortcutBindings: {
        mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
      },
    };
    await saveSettings(filePath, settings);
    const result = await loadSettings(filePath);
    expect(result.settings).toEqual(settings);
    expect(result.loadedFromDefaults).toBe(false);
    expect(result.warnings).toEqual([]);
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
    expect(result.warnings).toEqual([]);
  });

  it('returns load-time shortcut warnings for hand-edited invalid settings', async () => {
    const filePath = join(tmpDir, 'settings.json');
    await writeFile(filePath, JSON.stringify({
      shortcutBindings: {
        darwin: { next_bottleneck: 'Cmd+Ctrl+Space' },
        mac: { quick_launch: 'N' },
      },
    }), 'utf-8');
    const result = await loadSettings(filePath);
    expect(result.settings.shortcutBindings).toEqual({ mac: {} });
    expect(result.loadedFromDefaults).toBe(false);
    expect(result.warnings).toEqual([
      'Unknown shortcut platform "darwin" was ignored',
      'Shortcut "quick_launch" in mac bindings has invalid binding "N"; ignored',
    ]);
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
    expect(result.settings.defaultAgentType).toBe('claude-code');
    expect(result.settings.shortcutBindings).toEqual({});
    expect(result.loadedFromDefaults).toBe(false);
    expect(result.warnings).toEqual([]);
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
