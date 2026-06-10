import { lookup as dnsLookup } from 'node:dns';
import { Agent } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

export type PushEndpointValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
]);

export function validatePushEndpoint(endpoint: string): PushEndpointValidationResult {
  if (endpoint.length === 0) return { ok: false, reason: 'endpoint is required' };
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return { ok: false, reason: 'endpoint is too long' };

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'endpoint must be a valid URL' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'endpoint must use https' };
  if (url.username || url.password) return { ok: false, reason: 'endpoint must not include credentials' };

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return { ok: false, reason: 'endpoint host is required' };
  if (isBlockedHostname(hostname)) return { ok: false, reason: 'endpoint host is not allowed' };

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isBlockedIPv4(hostname)) return { ok: false, reason: 'endpoint address is not allowed' };
  if (ipVersion === 6 && isBlockedIPv6(hostname)) return { ok: false, reason: 'endpoint address is not allowed' };

  return { ok: true };
}

export function isValidPushEndpoint(endpoint: string): boolean {
  return validatePushEndpoint(endpoint).ok;
}

export function createPushEndpointValidationAgent(resolve: LookupFunction = dnsLookup as LookupFunction): Agent {
  return new Agent({ lookup: createPushEndpointLookup(resolve) });
}

export function createPushEndpointLookup(resolve: LookupFunction = dnsLookup as LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    const normalizedHostname = normalizeHostname(hostname);
    if (!normalizedHostname || isBlockedHostname(normalizedHostname)) {
      callback(blockedLookupError(hostname, 'blocked hostname'), '', 0);
      return;
    }

    resolve(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }

      const addresses = Array.isArray(address)
        ? address.map((entry) => entry.address)
        : [address];
      const blocked = addresses.find(isBlockedIPAddress);
      if (blocked) {
        callback(blockedLookupError(hostname, `blocked address ${blocked}`), '', 0);
        return;
      }
      if (addresses.length === 0) {
        callback(blockedLookupError(hostname, 'no resolved addresses'), '', 0);
        return;
      }

      callback(null, address, family);
    });
  };
}

export function isBlockedIPAddress(address: string): boolean {
  const normalizedAddress = normalizeHostname(address);
  const ipVersion = isIP(normalizedAddress);
  if (ipVersion === 4) return isBlockedIPv4(normalizedAddress);
  if (ipVersion === 6) return isBlockedIPv6(normalizedAddress);
  return true;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower;
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || METADATA_HOSTS.has(hostname);
}

function isBlockedIPv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [a, b, c] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isBlockedIPv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return true;

  const isUnspecified = bytes.every((byte) => byte === 0);
  const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const isUniqueLocal = (bytes[0] & 0xfe) === 0xfc;
  const isLinkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
  const isMulticast = bytes[0] === 0xff;
  const isIPv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;

  if (isIPv4Mapped) {
    return isBlockedIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  return isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isMulticast;
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
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

function blockedLookupError(hostname: string, reason: string): NodeJS.ErrnoException {
  const error = new Error(`push endpoint host ${hostname} is not allowed: ${reason}`) as NodeJS.ErrnoException;
  error.code = 'ERR_PUSH_ENDPOINT_BLOCKED';
  return error;
}
