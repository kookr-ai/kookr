import {
  PRIVATE_NETWORK_PROFILE_SCHEMA_VERSION,
  type CollaborationFeatureFlags,
  type CollaborationProfileHealth,
  type PrivateNetworkConnectionProfile,
  type PrivateNetworkHint,
  type PrivateNetworkTransportSecurity,
} from '../shared/contracts/collaboration-profile.js';

const DEFAULT_COLLABORATION_LISTENER_HOST = '127.0.0.1';
export const DEFAULT_COLLABORATION_LISTENER_PORT = 4802;

const NETWORK_HINTS = new Set<PrivateNetworkHint>([
  'tailscale',
  'wireguard',
  'ssh-tunnel',
  'lan',
  'corp-vpn',
  'other',
]);

const TRANSPORT_SECURITY_MODES = new Set<PrivateNetworkTransportSecurity>([
  'https-required',
  'loopback-tunnel-only',
  'authenticated-secure-tunnel',
]);

export interface CollaborationConfigEnv {
  [key: string]: string | undefined;
}

export interface CollaborationListenerConfig {
  featureFlags: CollaborationFeatureFlags;
  host: string;
  port: number;
  url: string;
  profile: PrivateNetworkConnectionProfile | null;
  health: CollaborationProfileHealth;
  shouldStartListener: boolean;
}

export interface ReadCollaborationConfigOptions {
  env: CollaborationConfigEnv;
  dashboardHost: string;
  dashboardPort: number;
  now?: () => Date;
}

export function envFlag(env: CollaborationConfigEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

function normalizeNetworkHint(raw: string | undefined): PrivateNetworkHint {
  const value = optionalString(raw);
  return value && NETWORK_HINTS.has(value as PrivateNetworkHint) ? value as PrivateNetworkHint : 'other';
}

function normalizeTransportSecurity(raw: string | undefined): PrivateNetworkTransportSecurity {
  const value = optionalString(raw);
  return value && TRANSPORT_SECURITY_MODES.has(value as PrivateNetworkTransportSecurity)
    ? value as PrivateNetworkTransportSecurity
    : 'loopback-tunnel-only';
}

function buildUrl(host: string, port: number): string {
  const bracketedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketedHost}:${port}`;
}

function listenerCollidesWithDashboard(
  listenerHost: string,
  listenerPort: number,
  dashboardHost: string,
  dashboardPort: number,
): boolean {
  if (listenerPort !== dashboardPort) return false;
  if (listenerHost === dashboardHost) return true;
  const allHosts = new Set(['0.0.0.0', '::', '']);
  return allHosts.has(listenerHost) || allHosts.has(dashboardHost);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function readCollaborationFeatureFlags(env: CollaborationConfigEnv): CollaborationFeatureFlags {
  return {
    profiles: envFlag(env, 'KOOKR_COLLABORATION_PROFILES'),
    listener: envFlag(env, 'KOOKR_COLLABORATION_LISTENER'),
    privateNetwork: envFlag(env, 'KOOKR_COLLABORATION_PRIVATE_NETWORK'),
    contactShareViewOnly: envFlag(env, 'KOOKR_COLLABORATION_CONTACT_SHARE_VIEW_ONLY'),
  };
}

export function readPrivateNetworkCollaborationConfig(
  opts: ReadCollaborationConfigOptions,
): CollaborationListenerConfig {
  const { env, dashboardHost, dashboardPort } = opts;
  const now = opts.now ?? (() => new Date());
  const featureFlags = readCollaborationFeatureFlags(env);
  const host = optionalString(env.KOOKR_COLLABORATION_HOST) ?? DEFAULT_COLLABORATION_LISTENER_HOST;
  const port = parsePort(env.KOOKR_COLLABORATION_PORT, DEFAULT_COLLABORATION_LISTENER_PORT);
  const url = buildUrl(host, port);

  const disabledFlag = Object.entries({
    profiles: featureFlags.profiles,
    listener: featureFlags.listener,
    privateNetwork: featureFlags.privateNetwork,
  }).find(([, enabled]) => !enabled)?.[0];
  if (disabledFlag) {
    return {
      featureFlags,
      host,
      port,
      url,
      profile: null,
      health: { state: 'disabled', reason: `feature-disabled:collaboration.${disabledFlag}` },
      shouldStartListener: false,
    };
  }

  if (listenerCollidesWithDashboard(host, port, dashboardHost, dashboardPort)) {
    return {
      featureFlags,
      host,
      port,
      url,
      profile: null,
      health: { state: 'disabled', reason: 'collaboration-listener-must-not-use-kookr-port' },
      shouldStartListener: false,
    };
  }

  const transportSecurity = normalizeTransportSecurity(env.KOOKR_COLLABORATION_TRANSPORT_SECURITY);
  if (!isLoopbackHost(host) && transportSecurity !== 'authenticated-secure-tunnel') {
    return {
      featureFlags,
      host,
      port,
      url,
      profile: null,
      health: { state: 'disabled', reason: 'cleartext-listener-requires-loopback-host' },
      shouldStartListener: false,
    };
  }

  const peerBaseUrl = optionalString(env.KOOKR_COLLABORATION_PEER_BASE_URL);
  const timestamp = now().toISOString();
  const profile: PrivateNetworkConnectionProfile | null = peerBaseUrl
    ? {
        schemaVersion: PRIVATE_NETWORK_PROFILE_SCHEMA_VERSION,
        profileId: optionalString(env.KOOKR_COLLABORATION_PROFILE_ID) ?? 'private-network-default',
        label: optionalString(env.KOOKR_COLLABORATION_PROFILE_LABEL) ?? 'Private network peer',
        peerBaseUrl,
        networkHint: normalizeNetworkHint(env.KOOKR_COLLABORATION_NETWORK_HINT),
        transportSecurity,
        ...(optionalString(env.KOOKR_COLLABORATION_EXPECTED_PEER_FINGERPRINT)
          ? { expectedPeerFingerprint: optionalString(env.KOOKR_COLLABORATION_EXPECTED_PEER_FINGERPRINT) }
          : {}),
        lastHealth: { state: 'ok', checkedAt: timestamp },
        createdAt: timestamp,
        updatedAt: timestamp,
      }
    : null;

  return {
    featureFlags,
    host,
    port,
    url,
    profile,
    health: profile ? { state: 'ok', checkedAt: timestamp } : { state: 'notConfigured' },
    shouldStartListener: true,
  };
}
