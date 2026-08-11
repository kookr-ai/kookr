/**
 * Validate KOOKR_TELEGRAM_API_URL before bot API / file CDN fetches.
 *
 * Default production traffic goes to api.telegram.org. Overrides exist for
 * tests and local fakes (loopback) and intentional private-LAN bot API
 * proxies, so those hosts stay allowed. Cloud metadata hostnames and
 * link-local addresses are always rejected so a mis-set env value cannot
 * become an SSRF foothold (parity with KOOKR_STT_URL / KOOKR_TTS_URL /
 * KOOKR_RELAY_URL host safety; contrast webhook which is fail-closed on
 * private space unless opt-in).
 *
 * Like the sibling guards this inspects the literal hostname/IP, not the
 * resolved address — DNS rebinding / NAT64-embedded metadata is a known
 * shared gap outside this leaf (issue #2219).
 */

import { isIP } from 'node:net';

export const MAX_TELEGRAM_API_URL_LENGTH = 2048;

export type TelegramApiUrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hostnames that always resolve to cloud instance-metadata services. */
const BLOCKED_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export function validateTelegramApiUrl(raw: string): TelegramApiUrlValidationResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'telegram API URL must be a string' };
  }

  const endpoint = raw.trim();
  if (endpoint.length === 0) {
    return { ok: false, reason: 'telegram API URL is required' };
  }
  if (endpoint.length > MAX_TELEGRAM_API_URL_LENGTH) {
    return { ok: false, reason: 'telegram API URL is too long' };
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'telegram API URL must be a valid URL' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: 'telegram API URL must use http or https' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'telegram API URL must not include credentials' };
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    return { ok: false, reason: 'telegram API URL host is required' };
  }

  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: 'telegram API URL host is not allowed' };
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isBlockedIPv4(hostname)) {
    return { ok: false, reason: 'telegram API URL address is not allowed' };
  }
  if (ipVersion === 6 && isBlockedIPv6(hostname)) {
    return { ok: false, reason: 'telegram API URL address is not allowed' };
  }

  return { ok: true, url: endpoint };
}

export function isValidTelegramApiUrl(raw: string): boolean {
  return validateTelegramApiUrl(raw).ok;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower;
}

function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAMES.has(hostname);
}

/**
 * Block only addresses that are unsafe for outbound server-side fetch while
 * still allowing loopback and RFC1918 (and CGNAT) for tests and private
 * bot-API proxies.
 */
function isBlockedIPv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }

  const [a, b] = octets as [number, number, number, number];
  // 0.0.0.0/8 unspecified; 169.254.0.0/16 link-local (incl. cloud metadata);
  // 224.0.0.0/4 multicast; 240.0.0.0/4 reserved / broadcast.
  return a === 0
    || (a === 169 && b === 254)
    || a >= 224;
}

function isBlockedIPv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return true;

  const isUnspecified = bytes.every((byte) => byte === 0);
  const isLinkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
  const isMulticast = bytes[0] === 0xff;
  const isIPv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;

  if (isIPv4Mapped) {
    return isBlockedIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  // Loopback (::1) and unique-local (fc00::/7) are allowed.
  return isUnspecified || isLinkLocal || isMulticast;
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
  // Drop zone id if present (fe80::1%eth0) — treat as invalid for URL host form.
  if (value.includes('%')) return null;
  const groups = value.split(':').map((group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return Number.NaN;
    return Number.parseInt(group, 16);
  });
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}
