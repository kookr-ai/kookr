import { apiFetch, fetchJson, type ApiResult } from './client.js';

export interface SuppressChipRequest {
  taskId: string | undefined;
  detectorId: string;
  agentType: string;
}

/**
 * Suppress (task scope → acknowledgement) or dismiss (class scope →
 * suppression) a coordinator chip. Fire-and-forget: mirrors the panel, which
 * ignores the response body.
 */
export async function suppressCoordinatorChip(
  scope: 'class' | 'task',
  body: SuppressChipRequest,
): Promise<void> {
  await apiFetch(
    scope === 'task' ? '/api/coordinator/acknowledgements' : '/api/coordinator/suppressions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export interface MarkPriorDoneRequest {
  taskId: string;
  priorTaskIds: string[];
  concurrencyToken: string | undefined;
}

/**
 * Mark a chain's prior tasks done. Parses the body before inspecting `ok` so
 * the caller can surface the server's `error` message.
 */
export function markPriorTasksDone(body: MarkPriorDoneRequest): Promise<ApiResult<{ error?: string }>> {
  return fetchJson<{ error?: string }>('/api/coordinator/mark-prior-done', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
