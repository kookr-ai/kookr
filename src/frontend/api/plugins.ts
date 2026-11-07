import { apiFetch, fetchResult, getJson, type ApiResult } from './client.js';
import type {
  ManagedPlugin,
  PluginsReadModel,
  PluginUpdateOutcome,
  PluginActionError,
  OwnSessionEnablementRequest,
  OwnSessionEnablementResult,
  OwnSessionInstallRequest,
  OwnSessionActionResult,
  OwnSessionActionError,
  ConfigDriftSurface,
  AutoUpdatePolicy,
  AutoUpdateSurface,
  AutoUpdateActionResult,
  AutoUpdateActionError,
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

// --- Own-session assist (RFC G3/R4) ---------------------------------------
// The caller MUST show the blast-radius disclosure (OWN_SESSION_BLAST_RADIUS)
// before invoking any of these — they mutate the operator's own sessions.

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** Enable/disable/reset a plugin for the operator's own sessions. */
export function ownSessionSetEnablement(
  req: OwnSessionEnablementRequest,
): Promise<ApiResult<OwnSessionEnablementResult | OwnSessionActionError | null>> {
  return fetchResult<OwnSessionEnablementResult | OwnSessionActionError>(
    '/api/plugins/own-session/enablement',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(req) },
  );
}

/** Install a plugin for the operator's own sessions. */
export function ownSessionInstall(
  req: OwnSessionInstallRequest,
): Promise<ApiResult<OwnSessionActionResult | OwnSessionActionError | null>> {
  return fetchResult<OwnSessionActionResult | OwnSessionActionError>(
    '/api/plugins/own-session/install',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(req) },
  );
}

/** Read the config-epoch reload-drift surface (RFC "Surfacing reload drift"). */
export function getConfigDrift(): Promise<ConfigDriftSurface> {
  return getJson<ConfigDriftSurface>('/api/plugins/config-drift');
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

// --- Fleet-aware auto-update (RFC Layer 4 / R6) ---------------------------

/** Read the fleet auto-update surface (per-plugin policy + audit trail + banners). */
export function getAutoUpdateSurface(): Promise<AutoUpdateSurface> {
  return getJson<AutoUpdateSurface>('/api/plugins/auto-update');
}

/** Set a plugin's auto-update policy (`off | notify | apply-when-idle`). */
export function setAutoUpdatePolicy(
  pluginId: string,
  policy: AutoUpdatePolicy,
): Promise<ApiResult<AutoUpdateActionResult | AutoUpdateActionError | null>> {
  return fetchResult<AutoUpdateActionResult | AutoUpdateActionError>(
    `/api/plugins/${encodeURIComponent(pluginId)}/auto-update`,
    { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ policy }) },
  );
}

/** Evaluate a plugin for auto-update right now (operator-triggered "run now"). */
export function evaluateAutoUpdate(
  pluginId: string,
): Promise<ApiResult<AutoUpdateActionResult | AutoUpdateActionError | null>> {
  return fetchResult<AutoUpdateActionResult | AutoUpdateActionError>(
    `/api/plugins/${encodeURIComponent(pluginId)}/auto-update/evaluate`,
    { method: 'POST' },
  );
}

/** Roll a plugin back to its retained pre-update snapshot (scoped rollback). */
export function rollbackAutoUpdate(
  pluginId: string,
): Promise<ApiResult<AutoUpdateActionResult | AutoUpdateActionError | null>> {
  return fetchResult<AutoUpdateActionResult | AutoUpdateActionError>(
    `/api/plugins/${encodeURIComponent(pluginId)}/auto-update/rollback`,
    { method: 'POST' },
  );
}

/** Dismiss a plugin's persistent auto-update banner (operator acknowledged it). */
export function dismissAutoUpdateBanner(
  pluginId: string,
): Promise<ApiResult<AutoUpdateActionResult | AutoUpdateActionError | null>> {
  return fetchResult<AutoUpdateActionResult | AutoUpdateActionError>(
    `/api/plugins/${encodeURIComponent(pluginId)}/auto-update/dismiss-banner`,
    { method: 'POST' },
  );
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
