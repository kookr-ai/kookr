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
 * The Kokoro voice ids the speech service in use says it can speak, read from its health
 * report as the server relays it. Empty when speech is off or unreachable, or when the
 * service does not list them: an older bundled service, or another speech server set with
 * KOOKR_TTS_URL.
 */
export async function getSpeechServiceKokoroVoices(): Promise<string[]> {
  try {
    const { ok, body } = await fetchResult<{ kokoro_voices?: unknown }>('/api/health/tts', { cache: 'no-store' });
    const voices = ok && body && typeof body === 'object' ? body.kokoro_voices : undefined;
    return Array.isArray(voices) ? voices.filter((voice): voice is string => typeof voice === 'string') : [];
  } catch {
    return [];
  }
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
