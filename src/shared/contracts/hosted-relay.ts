export const DEFAULT_HOSTED_RELAY_URL = 'https://share.kookr.dev';

export type HostedRelayMode = 'available' | 'maintenance' | 'emergencyDisabled' | 'notConfigured';

export type HostedRelayGate =
  | 'deploymentOwner'
  | 'environment'
  | 'tlsDomain'
  | 'accountDeviceAuth'
  | 'nodePairingAuth'
  | 'dataRetention'
  | 'rateLimitAbuse'
  | 'emergencyMaintenance'
  | 'metricsAlerts';

export type HostedRelayGateStatus = Record<HostedRelayGate, boolean>;

export const HOSTED_RELAY_GATES: readonly HostedRelayGate[] = [
  'deploymentOwner',
  'environment',
  'tlsDomain',
  'accountDeviceAuth',
  'nodePairingAuth',
  'dataRetention',
  'rateLimitAbuse',
  'emergencyMaintenance',
  'metricsAlerts',
];

export function parseHostedRelayMode(value: string | undefined): HostedRelayMode {
  switch (value) {
    case 'available':
    case 'maintenance':
    case 'emergencyDisabled':
    case 'notConfigured':
      return value;
    case 'emergency-disabled':
      return 'emergencyDisabled';
    default:
      return 'available';
  }
}

export function createHostedRelayGateStatus(value: boolean): HostedRelayGateStatus {
  return Object.fromEntries(HOSTED_RELAY_GATES.map((gate) => [gate, value])) as HostedRelayGateStatus;
}

export function hostedRelayStatusMessage(
  status: Pick<HostedRelayStatus, 'defaultEnabled' | 'operationalGatesMet' | 'mode'>,
  opts: { local?: boolean } = {},
): string {
  if (!status.defaultEnabled) return opts.local
    ? 'Hosted relay is not enabled for this Kookr instance.'
    : 'Hosted relay is disabled.';
  if (!status.operationalGatesMet) return opts.local
    ? 'Hosted relay setup is incomplete.'
    : 'Hosted relay operational gates are incomplete.';
  if (status.mode === 'maintenance') return opts.local
    ? 'Hosted relay is in maintenance mode. Existing local Kookr sessions keep running.'
    : 'Hosted relay is in maintenance mode.';
  if (status.mode === 'emergencyDisabled') return opts.local
    ? 'Hosted relay sharing is temporarily disabled. Local Kookr remains available.'
    : 'Hosted relay sharing is temporarily disabled.';
  return opts.local ? 'Hosted relay is ready.' : 'Hosted relay is available.';
}

export function parseHostedRelayFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

export function parseHostedRelayPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface HostedRelayStatus {
  configured: boolean;
  relayUrl: string;
  defaultEnabled: boolean;
  operationalGatesMet: boolean;
  mode: HostedRelayMode;
  message: string;
  checkedAt: string;
  gates: HostedRelayGateStatus;
  deploymentOwner?: string;
  environment?: string;
  tlsExpiresAt?: string | null;
  dataRetentionDays?: number;
  guestLinkPosture?: GuestLinkPosture;
}

export interface GuestLinkPosture {
  checkedAt: string;
  publicOrigin: {
    url: string;
    https: boolean;
  };
  securityHeaders: {
    cacheControlNoStore: boolean;
    referrerPolicyNoReferrer: boolean;
    contentTypeNosniff: boolean;
    frameAncestorsDenied: boolean;
  };
  webSocket: {
    originRequired: boolean;
    memberNonceRequired: boolean;
    nonceTtlMs: number;
    maxPayloadBytes: number;
    compression: 'disabled';
    unknownMessageCloses: boolean;
  };
}

export interface HostedRelayPairRequest {
  accountToken: string;
  displayName?: string;
  publicBaseUrl?: string;
}

export interface HostedRelayNodeCredentialResponse {
  nodeId: string;
  nodeToken: string;
}

export interface HostedRelayMetricSnapshot {
  ticketsCreated: number;
  ticketsAccepted: number;
  ticketsRevoked: number;
  ticketsExpired: number;
  acceptFailuresByReason: Record<string, number>;
  rateLimitHits: number;
  perShareLockCount: number;
  securityEvents: number;
  activeNodeSockets: number;
  activeClientSockets: number;
  maxNodeHeartbeatAgeMs: number | null;
  lastRevokePropagationLatencyMs: number | null;
  policySyncFailures: number;
  http5xxCount: number;
  recentWindowMs?: number;
  recent?: {
    rateLimitHits: number;
    perShareLockCount: number;
    securityEvents: number;
    http5xxCount: number;
  };
}

export interface HostedRelayAlert {
  code: string;
  severity: 'warning' | 'critical';
  message: string;
}

export interface HostedRelayMetricsResponse {
  metrics: HostedRelayMetricSnapshot;
  alerts: HostedRelayAlert[];
}
