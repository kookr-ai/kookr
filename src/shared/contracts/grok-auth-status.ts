import { resolveRoundRobinAgent, type AgentSelection, type AgentType } from './agent-types.js';

/** Offline Grok credential-cache verdict. Never includes token values. */
export const GROK_AUTH_STATUSES = ['ok', 'missing', 'expired', 'invalid'] as const;
export type GrokAuthStatus = (typeof GROK_AUTH_STATUSES)[number];

/** Same device-code login the launch adapter already tells operators to run. */
export const GROK_LOGIN_COMMAND = 'grok login --device-code';

export const GROK_AUTH_STATUS_PATH = '/api/grok-auth-status';

/**
 * Public Grok auth preflight for the Launch dialog.
 *
 * Status comes from {@link inspectGrokAuthFile} on the operator's shared
 * `auth.json`. The payload is deliberately small: no access tokens, refresh
 * tokens, API keys, emails, or auth-mode details.
 */
export interface GrokAuthStatusResponse {
  status: GrokAuthStatus;
  loginCommand: string;
  /** Safe operator message when status is not `ok`; null when credentials look usable. */
  message: string | null;
  /** True when a `grok-build` launch would be refused before a terminal exists. */
  launchWouldRefuse: boolean;
  /**
   * Current round-robin cursor. The Launch dialog combines this with the
   * advertised agent list to decide whether the *next* rotation would pick Grok.
   */
  roundRobinIndex: number;
}

export function isGrokAuthStatus(value: unknown): value is GrokAuthStatus {
  return typeof value === 'string' && (GROK_AUTH_STATUSES as readonly string[]).includes(value);
}

/** Parse a GET /api/grok-auth-status body. Rejects anything that is not the safe public shape. */
export function parseGrokAuthStatusResponse(value: unknown): GrokAuthStatusResponse | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isGrokAuthStatus(record.status)) return null;
  if (typeof record.loginCommand !== 'string' || !record.loginCommand.includes('grok login')) return null;
  if (record.message !== null && typeof record.message !== 'string') return null;
  if (typeof record.launchWouldRefuse !== 'boolean') return null;
  if (typeof record.roundRobinIndex !== 'number' || !Number.isInteger(record.roundRobinIndex)) return null;
  return {
    status: record.status,
    loginCommand: record.loginCommand,
    message: record.message,
    launchWouldRefuse: record.launchWouldRefuse,
    roundRobinIndex: record.roundRobinIndex,
  };
}

/** True when the current picker selection would launch Grok (directly or as the next rotation). */
export function grokAuthAffectsSelection(
  selection: AgentSelection,
  available: readonly AgentType[],
  roundRobinIndex: number,
): boolean {
  if (selection === 'grok-build') return true;
  if (selection !== 'round-robin') return false;
  return resolveRoundRobinAgent(roundRobinIndex, available) === 'grok-build';
}

/** Show the login banner when Grok would launch and preflight is not ok. */
export function shouldShowGrokAuthBanner(
  selection: AgentSelection,
  status: GrokAuthStatus | undefined,
  available: readonly AgentType[],
  roundRobinIndex: number,
): boolean {
  if (!status || status === 'ok') return false;
  return grokAuthAffectsSelection(selection, available, roundRobinIndex);
}

/**
 * Disable Launch only when the server would refuse this selection.
 *
 * An explicit `grok-build` pick is refused when preflight fails. Round-robin
 * is not: the launch service already drops Grok from the rotation (#2194)
 * and starts a remaining agent. RR is disabled only when that filter would
 * leave nothing launchable.
 */
export function shouldDisableLaunchForGrokAuth(
  selection: AgentSelection,
  launchWouldRefuse: boolean,
  available: readonly AgentType[],
  _roundRobinIndex: number,
): boolean {
  if (!launchWouldRefuse) return false;
  if (selection === 'grok-build') return true;
  if (selection !== 'round-robin') return false;
  return available.filter((type) => type !== 'grok-build').length === 0;
}
