import { apiFetch, fetchJson, fetchResult, type ApiResult } from './client.js';

/**
 * GET server settings, parsing the body regardless of status (matching the
 * settings dialog's `fetch().then(r => r.json())`). Callers that must react to
 * a failure use {@link getSettingsSnapshot} instead.
 */
export async function getSettings<T>(): Promise<T> {
  const res = await apiFetch('/api/settings');
  return (await res.json()) as T;
}

/**
 * GET server settings as a status envelope for best-effort readers (e.g. the
 * detail panel's reply-snippet hydration) that skip the body on a non-2xx.
 */
export function getSettingsSnapshot<T>(): Promise<ApiResult<T | null>> {
  return fetchResult<T>('/api/settings');
}

/**
 * PUT updated server settings. Parses the body before inspecting `ok` so the
 * caller can surface the server's `error` on failure or the normalized saved
 * settings on success.
 */
export function saveSettings<T>(updated: unknown): Promise<ApiResult<T>> {
  return fetchJson<T>('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
}
