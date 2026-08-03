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

/**
 * Optional last-restart timings from GET /api/deploy/status (issue #1973).
 * Present only after a successful `prod:restart` that wrote metrics; omitted
 * when the file is missing/corrupt. Mirrors server `LastRestartMetrics`.
 */
export interface LastRestartMetrics {
  at: string;
  m1Seconds: number;
  m2Seconds: number;
  apiBlackoutSeconds: number;
  dominantPhase: string;
  portFreeSeconds?: number;
  smokeSeconds?: number;
  totalSeconds?: number;
  path?: string;
}

/** SLO tiers for API blackout: ideal <1s, max <5s (issue #1979). */
export type ApiBlackoutTier = 'ok' | 'warn' | 'bad';

/** Ideal blackout target (seconds). Green when strictly below this. */
export const API_BLACKOUT_IDEAL_SECONDS = 1;
/** Soft SLO max (seconds). Amber below this; red at/above. */
export const API_BLACKOUT_SLO_SECONDS = 5;

/**
 * Map measured API blackout seconds to a traffic-light tier for the deploy
 * popover. Thresholds match the ops SLO: ideal <1s, max <5s.
 */
export function apiBlackoutTier(seconds: number): ApiBlackoutTier {
  if (!Number.isFinite(seconds) || seconds < 0) return 'bad';
  if (seconds < API_BLACKOUT_IDEAL_SECONDS) return 'ok';
  if (seconds < API_BLACKOUT_SLO_SECONDS) return 'warn';
  return 'bad';
}

/** Format a duration in seconds for compact popover display (e.g. `0.8s`, `3s`). */
export function formatBlackoutSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const rounded = Math.round(seconds * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}s`;
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
  /**
   * Last successful prod:restart phase timings (issue #1973/#1979).
   * Optional — when absent the deploy popover omits blackout UI entirely.
   */
  lastRestart?: LastRestartMetrics;
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
