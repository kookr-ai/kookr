import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  loadSettings,
  saveSettings,
  validateSettings,
  validateSettingsWithWarnings,
  isWithinQuietHours,
  DEFAULT_SETTINGS,
  MAX_REPLY_SNIPPETS,
} from './settings-store.js';

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

  it('TS-CLEANUP-001: accepts the task completion worktree cleanup preference', () => {
    expect(validateSettings({ cleanupWorktreeOnComplete: false })).toEqual({
      ...DEFAULT_SETTINGS,
      cleanupWorktreeOnComplete: false,
    });
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

  it('defaults autoCloseCompletionReadyDelayMin to 30', () => {
    expect(validateSettings({}).autoCloseCompletionReadyDelayMin).toBe(30);
    expect(DEFAULT_SETTINGS.autoCloseCompletionReadyDelayMin).toBe(30);
  });

  it('accepts a valid autoCloseCompletionReadyDelayMin', () => {
    expect(validateSettings({ autoCloseCompletionReadyDelayMin: 45 }).autoCloseCompletionReadyDelayMin).toBe(45);
  });

  it('clamps autoCloseCompletionReadyDelayMin below minimum to 1', () => {
    expect(validateSettings({ autoCloseCompletionReadyDelayMin: 0 }).autoCloseCompletionReadyDelayMin).toBe(1);
  });

  it('clamps autoCloseCompletionReadyDelayMin above maximum to 1440', () => {
    expect(validateSettings({ autoCloseCompletionReadyDelayMin: 99999 }).autoCloseCompletionReadyDelayMin).toBe(1440);
  });

  it('rounds fractional autoCloseCompletionReadyDelayMin', () => {
    expect(validateSettings({ autoCloseCompletionReadyDelayMin: 30.6 }).autoCloseCompletionReadyDelayMin).toBe(31);
  });

  it('falls back to the default when autoCloseCompletionReadyDelayMin is not a number', () => {
    expect(validateSettings({ autoCloseCompletionReadyDelayMin: 'soon' }).autoCloseCompletionReadyDelayMin).toBe(30);
  });

  it('fills missing new fields with defaults', () => {
    const result = validateSettings({ githubPollingEnabled: false, githubPollingIntervalSec: 120 });
    expect(result.autoWatchOssSources).toBe(true);
    expect(result.watchdogStaleThresholdSec).toBe(30);
    expect(result.repeatedErrorThreshold).toBe(3);
    expect(result.maxActiveTasks).toBe(10);
    expect(result.defaultAgentType).toBe('claude-code');
    expect(result.shortcutBindings).toEqual({});
    expect(result.speakVerbosity).toBe('medium');
    expect(result.cleanupWorktreeOnComplete).toBe(true);
    expect(result.replySnippets).toEqual([]);
    expect(result.autoCloseCompletionReadyDelayMin).toBe(30);
  });

  it('defaults replySnippets to an empty list', () => {
    expect(validateSettings({}).replySnippets).toEqual([]);
    expect(DEFAULT_SETTINGS.replySnippets).toEqual([]);
  });

  it('trims valid reply snippets and drops malformed ones with warnings', () => {
    const result = validateSettingsWithWarnings({
      replySnippets: [
        { label: ' Continue ', text: ' continue\n' },
        { label: ' ', text: 'missing label' },
        { label: 'Missing text', text: '' },
        { label: 'Bad text', text: 42 },
        'not an object',
      ],
    });

    expect(result.settings.replySnippets).toEqual([
      { label: 'Continue', text: 'continue' },
    ]);
    expect(result.warnings).toEqual([
      'Invalid replySnippets[1] (label and text must be non-empty strings); ignored',
      'Invalid replySnippets[2] (label and text must be non-empty strings); ignored',
      'Invalid replySnippets[3] (label and text must be non-empty strings); ignored',
      'Invalid replySnippets[4] (expected an object); ignored',
    ]);
  });

  it('caps reply snippets at 20 entries', () => {
    const snippets = Array.from({ length: MAX_REPLY_SNIPPETS + 5 }, (_, index) => ({
      label: `Snippet ${index + 1}`,
      text: `reply ${index + 1}`,
    }));

    const result = validateSettingsWithWarnings({ replySnippets: snippets });

    expect(result.settings.replySnippets).toHaveLength(MAX_REPLY_SNIPPETS);
    expect(result.settings.replySnippets.at(-1)).toEqual({
      label: `Snippet ${MAX_REPLY_SNIPPETS}`,
      text: `reply ${MAX_REPLY_SNIPPETS}`,
    });
    expect(result.warnings).toEqual([`replySnippets capped at ${MAX_REPLY_SNIPPETS} entries`]);
  });

  it('ignores non-array replySnippets with a warning', () => {
    const result = validateSettingsWithWarnings({ replySnippets: { label: 'Continue', text: 'continue' } });
    expect(result.settings.replySnippets).toEqual([]);
    expect(result.warnings).toEqual(['Invalid replySnippets (expected an array); ignored']);
  });

  it('accepts valid speakVerbosity values', () => {
    for (const value of ['terse', 'brief', 'medium', 'detailed'] as const) {
      const result = validateSettingsWithWarnings({ speakVerbosity: value });
      expect(result.settings.speakVerbosity).toBe(value);
      expect(result.warnings).toEqual([]);
    }
  });

  it("clamps invalid speakVerbosity string to 'medium' with a warning", () => {
    const result = validateSettingsWithWarnings({ speakVerbosity: 'bogus' });
    expect(result.settings.speakVerbosity).toBe('medium');
    expect(result.warnings).toEqual([
      'Unknown speakVerbosity value "bogus"; clamped to "medium"',
    ]);
  });

  it.each([
    { value: 42, serialized: '42' },
    { value: null, serialized: 'null' },
    { value: true, serialized: 'true' },
    { value: [], serialized: '[]' },
    { value: {}, serialized: '{}' },
  ])("clamps non-string speakVerbosity ($serialized) to 'medium' with a warning", ({ value, serialized }) => {
    const result = validateSettingsWithWarnings({ speakVerbosity: value });
    expect(result.settings.speakVerbosity).toBe('medium');
    expect(result.warnings).toEqual([
      `Unknown speakVerbosity value ${serialized}; clamped to "medium"`,
    ]);
  });

  it('omits speakVerbosity warning when field is absent', () => {
    const result = validateSettingsWithWarnings({});
    expect(result.settings.speakVerbosity).toBe('medium');
    expect(result.warnings).toEqual([]);
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
      cleanupWorktreeOnComplete: false,
      defaultAgentType: 'codex-cli' as const,
      roundRobinIndex: 3,
      shortcutBindings: {
        mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
      },
      speakVerbosity: 'detailed' as const,
      agentEffort: { 'claude-code': 'high' as const, 'codex-cli': 'minimal' as const },
      quietHours: [{ start: '22:00', end: '08:00' }],
      replySnippets: [{ label: 'Continue', text: 'continue' }],
      autoCloseCompletionReadyDelayMin: 45,
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
    expect(result.settings.speakVerbosity).toBe('medium');
    expect(result.settings.agentEffort).toEqual({});
    expect(result.settings.replySnippets).toEqual([]);
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

describe('agentEffort validation (#681)', () => {
  it('defaults to no effort overrides (model/CLI native defaults apply)', () => {
    expect(validateSettings({}).agentEffort).toEqual({});
    expect(DEFAULT_SETTINGS.agentEffort).toEqual({});
  });

  it('keeps an empty map empty rather than forcing a Codex max default', () => {
    expect(validateSettings({ agentEffort: {} }).agentEffort).toEqual({});
  });

  it('does not invent a Codex default when another agent has an explicit setting', () => {
    expect(validateSettings({ agentEffort: { 'claude-code': 'high' } }).agentEffort).toEqual({
      'claude-code': 'high',
    });
  });

  it('keeps valid (agent, level) pairs', () => {
    const { settings, warnings } = validateSettingsWithWarnings({
      agentEffort: { 'claude-code': 'max', 'codex-cli': 'minimal' },
    });
    expect(settings.agentEffort).toEqual({ 'claude-code': 'max', 'codex-cli': 'minimal' });
    expect(warnings).toEqual([]);
  });

  it('keeps max as a valid explicit Codex level', () => {
    const { settings, warnings } = validateSettingsWithWarnings({
      agentEffort: { 'codex-cli': 'max' },
    });
    expect(settings.agentEffort).toEqual({ 'codex-cli': 'max' });
    expect(warnings).toEqual([]);
  });

  it('keeps Sol ultra as an explicit Codex level', () => {
    const { settings, warnings } = validateSettingsWithWarnings({
      agentEffort: { 'codex-cli': 'ultra' },
    });
    expect(settings.agentEffort).toEqual({ 'codex-cli': 'ultra' });
    expect(warnings).toEqual([]);
  });

  it('drops unknown agent keys, with a warning', () => {
    const { settings, warnings } = validateSettingsWithWarnings({
      agentEffort: { 'gpt-5': 'high', 'claude-code': 'high' },
    });
    expect(settings.agentEffort).toEqual({ 'claude-code': 'high' });
    expect(warnings.some((w) => w.includes('gpt-5'))).toBe(true);
  });

  it('drops non-string values and ignores a non-object map', () => {
    expect(validateSettingsWithWarnings({ agentEffort: { 'claude-code': 3 } }).settings.agentEffort).toEqual({});
    expect(validateSettingsWithWarnings({ agentEffort: 'high' }).settings.agentEffort).toEqual({});
    expect(validateSettingsWithWarnings({ agentEffort: ['high'] }).settings.agentEffort).toEqual({});
  });
});

describe('quietHours validation', () => {
  it('defaults to an empty array', () => {
    expect(validateSettings({}).quietHours).toEqual([]);
  });

  it('keeps a valid window list', () => {
    const windows = [{ start: '22:00', end: '08:00' }, { start: '12:00', end: '13:00', days: [1, 2, 3] }];
    expect(validateSettings({ quietHours: windows }).quietHours).toEqual(windows);
  });

  it('drops a window with an invalid time and warns', () => {
    const { settings, warnings } = validateSettingsWithWarnings({
      quietHours: [{ start: '25:00', end: '08:00' }, { start: '22:00', end: '08:00' }],
    });
    expect(settings.quietHours).toEqual([{ start: '22:00', end: '08:00' }]);
    expect(warnings.some((w) => w.includes('invalid time'))).toBe(true);
  });

  it('drops an ambiguous window where start equals end', () => {
    const { settings, warnings } = validateSettingsWithWarnings({
      quietHours: [{ start: '09:00', end: '09:00' }],
    });
    expect(settings.quietHours).toEqual([]);
    expect(warnings.some((w) => w.includes('start equals end'))).toBe(true);
  });

  it('ignores a non-array quietHours value and warns', () => {
    const { settings, warnings } = validateSettingsWithWarnings({ quietHours: 'nope' });
    expect(settings.quietHours).toEqual([]);
    expect(warnings.some((w) => w.includes('must be an array'))).toBe(true);
  });

  it('normalizes days: dedups, sorts, drops out-of-range, warns', () => {
    const { settings, warnings } = validateSettingsWithWarnings({
      quietHours: [{ start: '22:00', end: '08:00', days: [2, 1, 2, 9, -1] }],
    });
    expect(settings.quietHours).toEqual([{ start: '22:00', end: '08:00', days: [1, 2] }]);
    expect(warnings.some((w) => w.includes('invalid entries'))).toBe(true);
  });

  it('treats a full week of days as "every day" (days omitted)', () => {
    const result = validateSettings({
      quietHours: [{ start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] }],
    });
    expect(result.quietHours).toEqual([{ start: '22:00', end: '08:00' }]);
  });

  it('caps the number of windows', () => {
    const many = Array.from({ length: 25 }, () => ({ start: '01:00', end: '02:00' }));
    const { settings, warnings } = validateSettingsWithWarnings({ quietHours: many });
    expect(settings.quietHours).toHaveLength(20);
    expect(warnings.some((w) => w.includes('capped'))).toBe(true);
  });
});

describe('isWithinQuietHours', () => {
  // Local-time fixtures. Jan 2026: 1st=Thu(4), 2nd=Fri(5), 3rd=Sat(6), 4th=Sun(0), 5th=Mon(1).
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 0, day, hour, minute);

  it('returns false with no windows', () => {
    expect(isWithinQuietHours([], at(5, 23))).toBe(false);
  });

  it('matches a same-day window with inclusive start and exclusive end', () => {
    const w = [{ start: '12:00', end: '13:00' }];
    expect(isWithinQuietHours(w, at(5, 12, 0))).toBe(true);
    expect(isWithinQuietHours(w, at(5, 12, 30))).toBe(true);
    expect(isWithinQuietHours(w, at(5, 11, 59))).toBe(false);
    expect(isWithinQuietHours(w, at(5, 13, 0))).toBe(false);
  });

  it('matches a window that wraps past midnight', () => {
    const w = [{ start: '22:00', end: '08:00' }];
    expect(isWithinQuietHours(w, at(5, 23, 0))).toBe(true); // evening half
    expect(isWithinQuietHours(w, at(6, 2, 0))).toBe(true); // morning half (next day)
    expect(isWithinQuietHours(w, at(5, 8, 0))).toBe(false); // end exclusive
    expect(isWithinQuietHours(w, at(5, 21, 59))).toBe(false); // before start
    expect(isWithinQuietHours(w, at(5, 9, 0))).toBe(false); // mid-day
  });

  it('applies a weekday filter to the start day of a wrap window', () => {
    const fridayNight = [{ start: '22:00', end: '08:00', days: [5] }]; // Fri 22:00 → Sat 08:00
    expect(isWithinQuietHours(fridayNight, at(2, 23, 0))).toBe(true); // Fri evening
    expect(isWithinQuietHours(fridayNight, at(3, 2, 0))).toBe(true); // Sat morning belongs to Fri
    expect(isWithinQuietHours(fridayNight, at(3, 23, 0))).toBe(false); // Sat evening — not Friday
    expect(isWithinQuietHours(fridayNight, at(4, 2, 0))).toBe(false); // Sun morning belongs to Sat
  });

  it('applies a weekday filter to a same-day window', () => {
    const weekdayLunch = [{ start: '12:00', end: '13:00', days: [1, 2, 3, 4, 5] }];
    expect(isWithinQuietHours(weekdayLunch, at(5, 12, 30))).toBe(true); // Monday
    expect(isWithinQuietHours(weekdayLunch, at(4, 12, 30))).toBe(false); // Sunday
  });
});
