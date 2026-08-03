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
    expect(result.completionReadyTtlMinutes).toBe(120);
    expect(result.hungTaskReapEnabled).toBe(true);
    expect(result.hungTaskReapMinutes).toBe(180);
    expect(result.postMergeCleanupBudgetMinutes).toBe(10);
  });

  it('defaults postMergeCleanupBudgetMinutes to 10 (issue #1560)', () => {
    expect(validateSettings({}).postMergeCleanupBudgetMinutes).toBe(10);
    expect(DEFAULT_SETTINGS.postMergeCleanupBudgetMinutes).toBe(10);
  });

  it('defaults automationKillSwitch off and safeModeSince null (issue #1710)', () => {
    expect(validateSettings({}).automationKillSwitch).toBe(false);
    expect(validateSettings({}).safeModeSince).toBeNull();
    expect(DEFAULT_SETTINGS.automationKillSwitch).toBe(false);
    expect(DEFAULT_SETTINGS.safeModeSince).toBeNull();
  });

  it('accepts an engaged kill-switch with ISO safeModeSince', () => {
    const result = validateSettings({
      automationKillSwitch: true,
      safeModeSince: '2026-08-01T12:00:00.000Z',
    });
    expect(result.automationKillSwitch).toBe(true);
    expect(result.safeModeSince).toBe('2026-08-01T12:00:00.000Z');
  });

  it('clears safeModeSince when the kill-switch is off', () => {
    const result = validateSettings({
      automationKillSwitch: false,
      safeModeSince: '2026-08-01T12:00:00.000Z',
    });
    expect(result.automationKillSwitch).toBe(false);
    expect(result.safeModeSince).toBeNull();
  });

  it('accepts a valid postMergeCleanupBudgetMinutes', () => {
    expect(validateSettings({ postMergeCleanupBudgetMinutes: 20 }).postMergeCleanupBudgetMinutes).toBe(20);
  });

  it('clamps postMergeCleanupBudgetMinutes below minimum to 1', () => {
    expect(validateSettings({ postMergeCleanupBudgetMinutes: 0 }).postMergeCleanupBudgetMinutes).toBe(1);
  });

  it('clamps postMergeCleanupBudgetMinutes above maximum to 120', () => {
    expect(validateSettings({ postMergeCleanupBudgetMinutes: 999 }).postMergeCleanupBudgetMinutes).toBe(120);
  });

  it('falls back to the default when postMergeCleanupBudgetMinutes is not a number', () => {
    expect(validateSettings({ postMergeCleanupBudgetMinutes: 'soon' }).postMergeCleanupBudgetMinutes).toBe(10);
  });

  it('defaults completionReadyTtlMinutes to 120', () => {
    expect(validateSettings({}).completionReadyTtlMinutes).toBe(120);
    expect(DEFAULT_SETTINGS.completionReadyTtlMinutes).toBe(120);
  });

  it('accepts a valid completionReadyTtlMinutes', () => {
    expect(validateSettings({ completionReadyTtlMinutes: 60 }).completionReadyTtlMinutes).toBe(60);
  });

  it('clamps completionReadyTtlMinutes below minimum to 5', () => {
    expect(validateSettings({ completionReadyTtlMinutes: 0 }).completionReadyTtlMinutes).toBe(5);
  });

  it('clamps completionReadyTtlMinutes above maximum to 10080', () => {
    expect(validateSettings({ completionReadyTtlMinutes: 999_999 }).completionReadyTtlMinutes).toBe(10_080);
  });

  it('falls back to the default when completionReadyTtlMinutes is not a number', () => {
    expect(validateSettings({ completionReadyTtlMinutes: 'later' }).completionReadyTtlMinutes).toBe(120);
  });

  it('defaults hungTaskReapEnabled to true and hungTaskReapMinutes to 180', () => {
    expect(validateSettings({}).hungTaskReapEnabled).toBe(true);
    expect(validateSettings({}).hungTaskReapMinutes).toBe(180);
    expect(DEFAULT_SETTINGS.hungTaskReapEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.hungTaskReapMinutes).toBe(180);
  });

  it('accepts hungTaskReapEnabled: false (config flag to disable)', () => {
    expect(validateSettings({ hungTaskReapEnabled: false }).hungTaskReapEnabled).toBe(false);
  });

  it('clamps hungTaskReapMinutes below minimum to 15', () => {
    expect(validateSettings({ hungTaskReapMinutes: 1 }).hungTaskReapMinutes).toBe(15);
  });

  it('clamps hungTaskReapMinutes above maximum to 10080', () => {
    expect(validateSettings({ hungTaskReapMinutes: 999_999 }).hungTaskReapMinutes).toBe(10_080);
  });

  it('defaults launchTimeoutSeconds to 180 and clamps to the 30–900 range (issue #1526 Phase C / #1528)', () => {
    expect(validateSettings({}).launchTimeoutSeconds).toBe(180);
    expect(DEFAULT_SETTINGS.launchTimeoutSeconds).toBe(180);
    expect(validateSettings({ launchTimeoutSeconds: 120 }).launchTimeoutSeconds).toBe(120);
    expect(validateSettings({ launchTimeoutSeconds: 1 }).launchTimeoutSeconds).toBe(30);
    expect(validateSettings({ launchTimeoutSeconds: 10_000 }).launchTimeoutSeconds).toBe(900);
    expect(validateSettings({ launchTimeoutSeconds: 'forever' }).launchTimeoutSeconds).toBe(180);
  });

  it('defaults deadManScheduleMinutes to 120 and clamps to the 30–1440 range (issue #1526 Phase C)', () => {
    expect(validateSettings({}).deadManScheduleMinutes).toBe(120);
    expect(DEFAULT_SETTINGS.deadManScheduleMinutes).toBe(120);
    expect(validateSettings({ deadManScheduleMinutes: 60 }).deadManScheduleMinutes).toBe(60);
    expect(validateSettings({ deadManScheduleMinutes: 5 }).deadManScheduleMinutes).toBe(30);
    expect(validateSettings({ deadManScheduleMinutes: 99_999 }).deadManScheduleMinutes).toBe(1440);
    expect(validateSettings({ deadManScheduleMinutes: 'never' }).deadManScheduleMinutes).toBe(120);
  });

  it('defaults scheduleFailureAlertThreshold to 3 and clamps to the 1–100 range (issue #1665)', () => {
    expect(validateSettings({}).scheduleFailureAlertThreshold).toBe(3);
    expect(DEFAULT_SETTINGS.scheduleFailureAlertThreshold).toBe(3);
    expect(validateSettings({ scheduleFailureAlertThreshold: 10 }).scheduleFailureAlertThreshold).toBe(10);
    expect(validateSettings({ scheduleFailureAlertThreshold: 0 }).scheduleFailureAlertThreshold).toBe(1);
    expect(validateSettings({ scheduleFailureAlertThreshold: 9_999 }).scheduleFailureAlertThreshold).toBe(100);
    expect(validateSettings({ scheduleFailureAlertThreshold: 'off' }).scheduleFailureAlertThreshold).toBe(3);
  });

  it('defaults maxPendingTasks to 24 and clamps to the 4–200 range (issue #1526 Phase C / C3)', () => {
    expect(validateSettings({}).maxPendingTasks).toBe(24);
    expect(DEFAULT_SETTINGS.maxPendingTasks).toBe(24);
    expect(validateSettings({ maxPendingTasks: 48 }).maxPendingTasks).toBe(48);
    expect(validateSettings({ maxPendingTasks: 1 }).maxPendingTasks).toBe(4);
    expect(validateSettings({ maxPendingTasks: 9_999 }).maxPendingTasks).toBe(200);
    expect(validateSettings({ maxPendingTasks: 'lots' }).maxPendingTasks).toBe(24);
  });

  it('defaults pendingTaskTtlMinutes to 240 and clamps to the 15–2880 range (issue #1526 Phase C / C3)', () => {
    expect(validateSettings({}).pendingTaskTtlMinutes).toBe(240);
    expect(DEFAULT_SETTINGS.pendingTaskTtlMinutes).toBe(240);
    expect(validateSettings({ pendingTaskTtlMinutes: 60 }).pendingTaskTtlMinutes).toBe(60);
    expect(validateSettings({ pendingTaskTtlMinutes: 1 }).pendingTaskTtlMinutes).toBe(15);
    expect(validateSettings({ pendingTaskTtlMinutes: 99_999 }).pendingTaskTtlMinutes).toBe(2880);
    expect(validateSettings({ pendingTaskTtlMinutes: 'forever' }).pendingTaskTtlMinutes).toBe(240);
  });

  it('defaults finishedAwaitingAckTtlMinutes to 15 and clamps to the 5-30 range, hard-capped at 30 (issue #1884)', () => {
    expect(validateSettings({}).finishedAwaitingAckTtlMinutes).toBe(15);
    expect(DEFAULT_SETTINGS.finishedAwaitingAckTtlMinutes).toBe(15);
    expect(validateSettings({ finishedAwaitingAckTtlMinutes: 10 }).finishedAwaitingAckTtlMinutes).toBe(10);
    expect(validateSettings({ finishedAwaitingAckTtlMinutes: 1 }).finishedAwaitingAckTtlMinutes).toBe(5);
    // Hard max: an operator override can never restore the chronic 30-45m
    // holds this setting exists to bound.
    expect(validateSettings({ finishedAwaitingAckTtlMinutes: 45 }).finishedAwaitingAckTtlMinutes).toBe(30);
    expect(validateSettings({ finishedAwaitingAckTtlMinutes: 99_999 }).finishedAwaitingAckTtlMinutes).toBe(30);
    expect(validateSettings({ finishedAwaitingAckTtlMinutes: 'forever' }).finishedAwaitingAckTtlMinutes).toBe(15);
  });

  it('defaults hungSuspectTtlMinutes to 25 and clamps to the 10-60 range, hard-capped at 60 (issue #1935)', () => {
    expect(validateSettings({}).hungSuspectTtlMinutes).toBe(25);
    expect(DEFAULT_SETTINGS.hungSuspectTtlMinutes).toBe(25);
    expect(validateSettings({ hungSuspectTtlMinutes: 20 }).hungSuspectTtlMinutes).toBe(20);
    expect(validateSettings({ hungSuspectTtlMinutes: 1 }).hungSuspectTtlMinutes).toBe(10);
    expect(validateSettings({ hungSuspectTtlMinutes: 90 }).hungSuspectTtlMinutes).toBe(60);
    expect(validateSettings({ hungSuspectTtlMinutes: 99_999 }).hungSuspectTtlMinutes).toBe(60);
    expect(validateSettings({ hungSuspectTtlMinutes: 'forever' }).hungSuspectTtlMinutes).toBe(25);
  });

  it('defaults spawnBurstLimit to 30 and clamps to the 5–500 range (issue #1526 Phase C / C3)', () => {
    expect(validateSettings({}).spawnBurstLimit).toBe(30);
    expect(DEFAULT_SETTINGS.spawnBurstLimit).toBe(30);
    expect(validateSettings({ spawnBurstLimit: 100 }).spawnBurstLimit).toBe(100);
    expect(validateSettings({ spawnBurstLimit: 0 }).spawnBurstLimit).toBe(5);
    expect(validateSettings({ spawnBurstLimit: 9_999 }).spawnBurstLimit).toBe(500);
    expect(validateSettings({ spawnBurstLimit: null }).spawnBurstLimit).toBe(30);
  });

  it('defaults spawnBurstWindowMinutes to 10 and clamps to the 1–120 range (issue #1526 Phase C / C3)', () => {
    expect(validateSettings({}).spawnBurstWindowMinutes).toBe(10);
    expect(DEFAULT_SETTINGS.spawnBurstWindowMinutes).toBe(10);
    expect(validateSettings({ spawnBurstWindowMinutes: 30 }).spawnBurstWindowMinutes).toBe(30);
    expect(validateSettings({ spawnBurstWindowMinutes: 0 }).spawnBurstWindowMinutes).toBe(1);
    expect(validateSettings({ spawnBurstWindowMinutes: 9_999 }).spawnBurstWindowMinutes).toBe(120);
    expect(validateSettings({ spawnBurstWindowMinutes: false }).spawnBurstWindowMinutes).toBe(10);
  });

  it('defaults reservedActiveSlots to 2 and clamps to the 0–12 range (issue #1564)', () => {
    expect(validateSettings({}).reservedActiveSlots).toBe(2);
    expect(DEFAULT_SETTINGS.reservedActiveSlots).toBe(2);
    expect(validateSettings({ reservedActiveSlots: 3 }).reservedActiveSlots).toBe(3);
    expect(validateSettings({ reservedActiveSlots: -5 }).reservedActiveSlots).toBe(0);
    expect(validateSettings({ reservedActiveSlots: 9_999 }).reservedActiveSlots).toBe(12);
    expect(validateSettings({ reservedActiveSlots: 2.6 }).reservedActiveSlots).toBe(3);
    expect(validateSettings({ reservedActiveSlots: null }).reservedActiveSlots).toBe(2);
  });

  it("defaults reservedSlotSources to ['kookr'] and cleans the list (issue #1564)", () => {
    expect(validateSettings({}).reservedSlotSources).toEqual(['kookr']);
    expect(DEFAULT_SETTINGS.reservedSlotSources).toEqual(['kookr']);
    // Trims, drops blanks/non-strings, and de-duplicates order-preserving.
    expect(
      validateSettings({ reservedSlotSources: [' kookr ', '', 'ops', 'kookr', 42, null] }).reservedSlotSources,
    ).toEqual(['kookr', 'ops']);
    // A non-array falls back to the default.
    expect(validateSettings({ reservedSlotSources: 'kookr' }).reservedSlotSources).toEqual(['kookr']);
    // An explicit empty array is honored (reservation held from everyone).
    expect(validateSettings({ reservedSlotSources: [] }).reservedSlotSources).toEqual([]);
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
      completionReadyTtlMinutes: 90,
      hungTaskReapEnabled: false,
      hungTaskReapMinutes: 240,
      launchTimeoutSeconds: 300,
      deadManScheduleMinutes: 240,
      scheduleFailureAlertThreshold: 5,
      maxPendingTasks: 48,
      pendingTaskTtlMinutes: 120,
      finishedAwaitingAckTtlMinutes: 20,
      hungSuspectTtlMinutes: 30,
      spawnBurstLimit: 60,
      spawnBurstWindowMinutes: 15,
      reservedActiveSlots: 3,
      reservedSlotSources: ['kookr', 'ops'],
      postMergeCleanupBudgetMinutes: 15,
      automationKillSwitch: false,
      safeModeSince: null,
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
