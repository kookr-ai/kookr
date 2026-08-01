import { apiFetch, fetchJson, getJson, type ApiResult } from './client.js';

/**
 * GET one task's full detail (prompt/criteria bodies), the payload the compact
 * list projection omits. Throws {@link ApiError} on a non-2xx.
 */
export function getTask<T>(taskId: string): Promise<T> {
  return getJson<T>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

/** GET the compact task list (cwd + session ids only). Throws on a non-2xx. */
export function getCompactTasks<T>(): Promise<T> {
  return getJson<T>('/api/tasks?view=compact');
}

/**
 * PATCH a task's dependency edges. Parses the body before inspecting `ok`
 * (matching the inline call) so the caller can surface a server error message.
 */
export function patchTaskEdges<T>(taskId: string, next: unknown): Promise<ApiResult<T>> {
  return fetchJson<T>(`/api/tasks/${encodeURIComponent(taskId)}/edges`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
}

async function getLatestOrThrow<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await apiFetch(path, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed with ${res.status}`);
  }
  // Strict success parse: a 2xx with an empty/unparseable body rejects (driving
  // the panel into its error state), matching the panels' original inline
  // `return res.json()` rather than yielding a `null` "ready" projection.
  return (await res.json()) as T;
}

/**
 * GET the evolution-run projection for a task. On a non-2xx throws the server's
 * `error` message, falling back to `Request failed with <status>`.
 */
export function getEvolutionRun<T>(taskId: string, signal: AbortSignal): Promise<T> {
  return getLatestOrThrow<T>(`/api/tasks/${encodeURIComponent(taskId)}/evolution`, signal);
}

/**
 * GET the Ralph-loop iteration read model for a task. Same error convention as
 * {@link getEvolutionRun}.
 */
export function getRalphLoopIterations<T>(taskId: string, signal: AbortSignal): Promise<T> {
  return getLatestOrThrow<T>(`/api/tasks/${encodeURIComponent(taskId)}/ralph-loop/iterations`, signal);
}
