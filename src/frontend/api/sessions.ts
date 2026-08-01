import { getJson } from './client.js';

/**
 * GET the effective hook settings recorded for a session. Throws
 * {@link ApiError} on a non-2xx; callers branch on `status === 404` to show the
 * "no settings recorded" message.
 */
export function getEffectiveHookSettings<T>(sessionId: string): Promise<T> {
  return getJson<T>(`/api/sessions/${encodeURIComponent(sessionId)}/effective-hook-settings`);
}
