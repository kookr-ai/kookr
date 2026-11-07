import { apiFetch, fetchResult, type ApiResult } from './client.js';
import type {
  PluginsReadModel,
  PluginUpdateOutcome,
  PluginActionError,
} from '../../shared/contracts/plugins.js';

/**
 * Fleet Plugin Manager API client (RFC Layer 1). Parses the body before
 * inspecting `ok` so an error payload can accompany a non-2xx response.
 */
export async function getPlugins(): Promise<ApiResult<PluginsReadModel>> {
  const res = await apiFetch('/api/plugins');
  const body = (await res.json()) as PluginsReadModel;
  return { ok: res.ok, status: res.status, body };
}

/** Update one plugin via `POST /api/plugins/:id/update`. */
export function updatePlugin(
  id: string,
): Promise<ApiResult<PluginUpdateOutcome | PluginActionError | null>> {
  return fetchResult<PluginUpdateOutcome | PluginActionError>(
    `/api/plugins/${encodeURIComponent(id)}/update`,
    { method: 'POST' },
  );
}
