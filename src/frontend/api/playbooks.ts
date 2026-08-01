import { apiFetch, type ApiResult } from './client.js';

const LAUNCH_HEADERS = {
  'Content-Type': 'application/json',
  'X-Kookr-Launch-Source': 'ui',
} as const;

async function postLaunch(path: string, payload: unknown): Promise<ApiResult<Record<string, unknown>>> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: LAUNCH_HEADERS,
    body: JSON.stringify(payload),
  });
  // Default to `{}` (not null) so 409-conflict parsing can read fields safely,
  // matching the panel's original `res.json().catch(() => ({}))`.
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

/** Start a looped (Ralph) playbook. Returns status + parsed body for 409 conflict handling. */
export function launchLoopedPlaybook(payload: unknown): Promise<ApiResult<Record<string, unknown>>> {
  return postLaunch('/api/playbooks/ralph-loop', payload);
}

/** Replace an existing task's Ralph loop with a new looped launch. */
export function replaceRalphLoopWithNew(
  taskId: string,
  payload: unknown,
): Promise<ApiResult<Record<string, unknown>>> {
  return postLaunch(`/api/tasks/${encodeURIComponent(taskId)}/ralph-loop/replace-with-new`, payload);
}
