import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function effectiveHookSettingsPath(settingsDir: string, tmuxName: string): string | undefined {
  if (!SAFE_SESSION_ID_RE.test(tmuxName)) return undefined;
  return join(settingsDir, `${tmuxName}.json`);
}

export function readPersistedHookSettings(settingsDir: string, tmuxName: string): unknown | undefined {
  const path = effectiveHookSettingsPath(settingsDir, tmuxName);
  if (!path || !existsSync(path)) return undefined;

  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}
