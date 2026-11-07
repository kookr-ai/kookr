import { apiFetch, fetchResult, type ApiResult } from './client.js';
import type {
  ManagedPlugin,
  PluginsReadModel,
  PluginUpdateOutcome,
  PluginActionError,
} from '../../shared/contracts/plugins.js';
import type {
  PluginInstallResult,
  PluginUpdateError,
  PluginVersionStatus,
} from '../../shared/contracts/plugin-version.js';

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

/** Project a fleet `ManagedPlugin` row down to the toolkit badge's `PluginVersionStatus`. */
function managedToVersionStatus(p: ManagedPlugin): PluginVersionStatus {
  return {
    pluginId: p.id,
    installedVersion: p.installedVersion,
    availableVersion: p.availableVersion,
    stale: p.staleness.state === 'behind',
  };
}

/**
 * Toolkit install/stale status for the install banner + TopBar badge, read from
 * the plugin read model (slice 1d — replaces the deploy-status `plugin` field).
 */
export async function getToolkitStatus(): Promise<PluginVersionStatus | null> {
  const { ok, body } = await getPlugins();
  if (!ok) return null;
  return body.toolkit;
}

/** Install the kookr-toolkit plugin via `POST /api/plugins/install` (slice 1d). */
export function installToolkitPlugin(): Promise<ApiResult<PluginInstallResult | PluginUpdateError | null>> {
  return fetchResult<PluginInstallResult | PluginUpdateError>('/api/plugins/install', { method: 'POST' });
}

/**
 * Update the toolkit (or any single plugin) via `POST /api/plugins/:id/update`,
 * mapping the fleet result to the badge's `PluginVersionStatus` shape so the
 * TopBar popover keeps its existing rendering (slice 1d).
 */
export async function updateToolkitPlugin(
  pluginId: string,
): Promise<ApiResult<{ plugin?: PluginVersionStatus; error?: string } | null>> {
  const { ok, status, body } = await updatePlugin(pluginId);
  if (ok && body && 'status' in body && body.status === 'updated') {
    return { ok, status, body: { plugin: managedToVersionStatus(body.plugin) } };
  }
  const err = body as PluginActionError | null;
  return { ok, status, body: { error: err?.error ?? 'Plugin update failed' } };
}
