import { readFile, writeFile, rename } from 'node:fs/promises';

export interface KookrSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  autoWatchOssSources: boolean;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
}

export const DEFAULT_SETTINGS: KookrSettings = {
  githubPollingEnabled: true,
  githubPollingIntervalSec: 60,
  autoWatchOssSources: true,
  watchdogStaleThresholdSec: 30,
  repeatedErrorThreshold: 3,
  maxActiveTasks: 10,
};

const MIN_POLLING_INTERVAL = 15;
const MAX_POLLING_INTERVAL = 600;
const MIN_STALE_THRESHOLD = 15;
const MAX_STALE_THRESHOLD = 90;
const MIN_ERROR_THRESHOLD = 2;
const MAX_ERROR_THRESHOLD = 10;
const MIN_ACTIVE_TASKS = 1;
const MAX_ACTIVE_TASKS = 25;

/** Validate and clamp a raw settings object, filling in defaults for missing/invalid values. */
export function validateSettings(raw: Record<string, unknown>): KookrSettings {
  const enabled = typeof raw.githubPollingEnabled === 'boolean'
    ? raw.githubPollingEnabled
    : DEFAULT_SETTINGS.githubPollingEnabled;

  let interval = DEFAULT_SETTINGS.githubPollingIntervalSec;
  if (typeof raw.githubPollingIntervalSec === 'number' && Number.isFinite(raw.githubPollingIntervalSec)) {
    interval = Math.max(MIN_POLLING_INTERVAL, Math.min(MAX_POLLING_INTERVAL, Math.round(raw.githubPollingIntervalSec)));
  }

  const autoWatchOssSources = typeof raw.autoWatchOssSources === 'boolean'
    ? raw.autoWatchOssSources
    : DEFAULT_SETTINGS.autoWatchOssSources;

  let staleThreshold = DEFAULT_SETTINGS.watchdogStaleThresholdSec;
  if (typeof raw.watchdogStaleThresholdSec === 'number' && Number.isFinite(raw.watchdogStaleThresholdSec)) {
    staleThreshold = Math.max(MIN_STALE_THRESHOLD, Math.min(MAX_STALE_THRESHOLD, Math.round(raw.watchdogStaleThresholdSec)));
  }

  let errorThreshold = DEFAULT_SETTINGS.repeatedErrorThreshold;
  if (typeof raw.repeatedErrorThreshold === 'number' && Number.isFinite(raw.repeatedErrorThreshold)) {
    errorThreshold = Math.max(MIN_ERROR_THRESHOLD, Math.min(MAX_ERROR_THRESHOLD, Math.round(raw.repeatedErrorThreshold)));
  }

  let maxTasks = DEFAULT_SETTINGS.maxActiveTasks;
  if (typeof raw.maxActiveTasks === 'number' && Number.isFinite(raw.maxActiveTasks)) {
    maxTasks = Math.max(MIN_ACTIVE_TASKS, Math.min(MAX_ACTIVE_TASKS, Math.round(raw.maxActiveTasks)));
  }

  return {
    githubPollingEnabled: enabled,
    githubPollingIntervalSec: interval,
    autoWatchOssSources,
    watchdogStaleThresholdSec: staleThreshold,
    repeatedErrorThreshold: errorThreshold,
    maxActiveTasks: maxTasks,
  };
}

export interface SettingsLoadResult {
  settings: KookrSettings;
  loadedFromDefaults: boolean;
}

/** Load settings from a JSON file. Returns defaults on missing/corrupt file. */
export async function loadSettings(filePath: string): Promise<SettingsLoadResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(`[settings] Invalid settings file (not an object), using defaults`);
      return { settings: { ...DEFAULT_SETTINGS }, loadedFromDefaults: true };
    }
    return { settings: validateSettings(parsed as Record<string, unknown>), loadedFromDefaults: false };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      // File doesn't exist yet — normal on first run
      return { settings: { ...DEFAULT_SETTINGS }, loadedFromDefaults: true };
    }
    console.warn(`[settings] Failed to read settings file, using defaults:`, err instanceof Error ? err.message : err);
    return { settings: { ...DEFAULT_SETTINGS }, loadedFromDefaults: true };
  }
}

/** Save settings to a JSON file. Uses write-to-temp + rename for crash safety. */
export async function saveSettings(filePath: string, settings: KookrSettings): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, filePath);
}
