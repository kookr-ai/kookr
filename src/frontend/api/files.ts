import { fetchResult, type ApiResult } from './client.js';

/**
 * GET file metadata for the viewer. Parses defensively (`body` is `null` on an
 * unparseable response) so the caller can distinguish a transport/parse failure
 * from a typed hit/miss union.
 */
export function getFileMeta<T>(filePath: string, signal: AbortSignal): Promise<ApiResult<T | null>> {
  return fetchResult<T>(`/api/files/meta?path=${encodeURIComponent(filePath)}`, { signal });
}

/**
 * GET a captured edit/write event for an agent tool use. Parses defensively so
 * the caller can render a specific message for a `null`/miss body.
 */
export function getEditEvent<T>(
  agentId: string,
  toolUseId: string,
  signal: AbortSignal,
): Promise<ApiResult<T | null>> {
  return fetchResult<T>(
    `/api/agents/${encodeURIComponent(agentId)}/edit-events/${encodeURIComponent(toolUseId)}`,
    { signal },
  );
}

/**
 * GET what a task changed in its working directory, for the Changes tab
 * (#4024). `body` is `null` on an unparseable response.
 */
export function getTaskChanges<T>(taskId: string, signal: AbortSignal): Promise<ApiResult<T | null>> {
  return fetchResult<T>(`/api/tasks/${encodeURIComponent(taskId)}/changes`, { signal });
}

/** GET one file's patch from a task's change list (#4024). */
export function getTaskChangeFile<T>(taskId: string, filePath: string, signal: AbortSignal): Promise<ApiResult<T | null>> {
  return fetchResult<T>(
    `/api/tasks/${encodeURIComponent(taskId)}/changes/file?path=${encodeURIComponent(filePath)}`,
    { signal },
  );
}
