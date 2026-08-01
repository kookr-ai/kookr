import { apiFetch, fetchResult, type ApiResult } from './client.js';
import type {
  PluginInstallResult,
  PluginUpdateError,
  PluginUpdateResult,
  PluginVersionStatus,
} from '../../shared/contracts/plugin-version.js';

export interface ToolkitStatus {
  stale: boolean;
  checkedCount: number;
  staleCount: number;
}

export interface DeployStatus {
  configured: boolean;
  available?: boolean;
  deploying?: boolean;
  toolkit?: ToolkitStatus;
  toolkitError?: string;
  plugin?: PluginVersionStatus;
  currentShort?: string;
  latestShort?: string;
  behindCount?: number;
  commits?: { hash: string; subject: string }[];
  error?: string;
  /** Port this dashboard's backend is bound to. Undefined when talking to a pre-update backend. */
  runningPort?: number;
  /** Port the deploy button targets (the production instance). */
  prodPort?: number;
}

/**
 * GET the deploy/plugin status surface. Parses the body before inspecting
 * `ok` (a malformed body rejects) so callers can render an error payload that
 * accompanies a non-2xx response.
 */
export async function getDeployStatus(): Promise<ApiResult<DeployStatus>> {
  const res = await apiFetch('/api/deploy/status');
  const body = (await res.json()) as DeployStatus;
  return { ok: res.ok, status: res.status, body };
}

export function triggerDeploy(): Promise<ApiResult<{ error?: string } | null>> {
  return fetchResult<{ error?: string }>('/api/deploy/trigger', { method: 'POST' });
}

export type ToolkitRefreshBody = { toolkit?: ToolkitStatus; error?: string } & Record<string, unknown>;

export function refreshToolkitLinks(): Promise<ApiResult<ToolkitRefreshBody | null>> {
  return fetchResult<ToolkitRefreshBody>('/api/deploy/toolkit-refresh', { method: 'POST' });
}

export function updateToolkitPlugin(): Promise<ApiResult<PluginUpdateResult | PluginUpdateError | null>> {
  return fetchResult<PluginUpdateResult | PluginUpdateError>('/api/deploy/plugin-update', { method: 'POST' });
}

export function installToolkitPlugin(): Promise<ApiResult<PluginInstallResult | PluginUpdateError | null>> {
  return fetchResult<PluginInstallResult | PluginUpdateError>('/api/deploy/plugin-install', { method: 'POST' });
}
