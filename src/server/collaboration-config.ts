import { isIP } from 'node:net';

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

/**
 * Cloud instance-metadata hostnames that must never be reachable from the
 * signed collaboration update poller. Mirrors the always-blocked host class
 * used by the sibling egress guards (webhook / speech / relay push).
 */
const CLOUD_METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export type CollaborationPeerUrlValidation =
  | { ok: true }
  | { ok: false; reason: string };

function normalizePeerHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/** IPv4 link-local (169.254.0.0/16) — covers the 169.254.169.254 metadata IP. */
function isLinkLocalIPv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return a === 169 && b === 254;
}

/** IPv6 link-local (fe80::/10), plus IPv4-mapped link-local (::ffff:169.254.x.x). */
function isLinkLocalIPv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return false;
  const isIPv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isIPv4Mapped) {
    return isLinkLocalIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  return bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
}

function ipv6ToBytes(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const left = parseIPv6Groups(halves[0] ?? '');
  const right = parseIPv6Groups(halves[1] ?? '');
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (groups.length !== 8) return null;

  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function parseIPv6Groups(value: string): number[] | null {
  if (value === '') return [];
  const groups = value.split(':').map((group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return Number.NaN;
    return Number.parseInt(group, 16);
  });
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * Validate the collaboration peer base URL before it can reach a server-side
 * `fetch` in the update poller. Private-LAN peers are intentional for
 * collaboration and remain allowed; only http(s) is accepted, embedded
 * credentials are rejected, and always-blocked host classes (cloud
 * instance-metadata hostnames, link-local addresses) are rejected — the same
 * class the webhook / speech / relay egress guards reject.
 *
 * Like those sibling guards this inspects the literal hostname/IP, not the
 * resolved address, so NAT64-embedded metadata (`64:ff9b::a9fe:a9fe`) shares
 * the siblings' known gap; deeper resolve-time SSRF hardening is out of scope
 * for this leaf (see issue #2182).
 */
export function validateCollaborationPeerBaseUrl(rawUrl: string): CollaborationPeerUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'peer-url-invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'peer-url-protocol-not-http' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'peer-url-has-credentials' };
  }
  const hostname = normalizePeerHostname(url.hostname);
  if (!hostname) return { ok: false, reason: 'peer-url-missing-host' };
  if (CLOUD_METADATA_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: 'peer-url-cloud-metadata-host' };
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isLinkLocalIPv4(hostname)) {
    return { ok: false, reason: 'peer-url-link-local-host' };
  }
  if (ipVersion === 6 && isLinkLocalIPv6(hostname)) {
    return { ok: false, reason: 'peer-url-link-local-host' };
  }
  return { ok: true };
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

  if (peerBaseUrl) {
    const peerValidation = validateCollaborationPeerBaseUrl(peerBaseUrl);
    if (!peerValidation.ok) {
      // The peer URL feeds a server-side fetch from the signed update poller.
      // A rejected host class (cloud metadata / link-local) must not produce a
      // profile, so the poller never starts and never reaches fetch. The
      // inbound listener is independent of the peer URL and keeps running.
      return {
        featureFlags,
        host,
        port,
        url,
        profile: null,
        health: { state: 'disabled', reason: `collaboration-peer-url-rejected:${peerValidation.reason}` },
        shouldStartListener: true,
      };
    }
  }

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
