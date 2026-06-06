import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { MiddlewareHandler } from 'hono';

export const LOCAL_OWNER_ID = 'local-owner';

export interface OwnerIdentity {
  actorId?: string;
  ownerId?: string;
  local?: boolean;
}

export function isOwnerLocal(identity: OwnerIdentity | undefined): boolean {
  if (!identity) return false;
  return identity.local === true
    || identity.actorId === LOCAL_OWNER_ID
    || identity.ownerId === LOCAL_OWNER_ID;
}

// --- Bind-host classification + API token authentication (issue #708) ---
//
// When the dashboard binds to a non-loopback host (a LAN IP or 0.0.0.0), full
// agent control — task launch, stop, terminal input — is reachable by anyone
// who can hit the port. This module adds a deterministic, fail-closed bearer
// token gate that is enforced on state-changing HTTP requests and on the
// WebSocket upgrade ONLY when the bind host is non-loopback. Loopback binds
// (the default `127.0.0.1`) stay completely token-free.

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Header an HTTP/WS client may use to present the API token in addition to the
 * standard `Authorization: Bearer <token>` form. Browsers cannot set arbitrary
 * headers on a `WebSocket` handshake, so the upgrade path also accepts the
 * token via a `?token=`/`?api_token=` query parameter.
 */
export const API_TOKEN_HEADER = 'x-kookr-api-token';

/**
 * Classify a bind host as loopback. Mirrors the loopback set used by the admin
 * route gate (`src/server/routes/admin-routes.ts`) and additionally treats the
 * whole `127.0.0.0/8` range plus `localhost` and the IPv6 loopback as loopback.
 * Anything else — a concrete LAN IP, a hostname, or the wildcard `0.0.0.0` /
 * `::` — is non-loopback and triggers the token requirement.
 */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null) return false;
  let normalized = host.trim().toLowerCase();
  if (normalized === '') return false;
  // Strip IPv6 brackets, e.g. `[::1]`.
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '::ffff:127.0.0.1'
    || normalized === '127.0.0.1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Resolved API-auth posture for the running server. `required: false` means the
 * server is on a loopback bind and every request/upgrade passes through
 * untouched. `required: true` carries the single expected bearer token.
 */
export interface ApiAuthConfig {
  required: boolean;
  token?: string;
}

/**
 * Outcome of resolving the API-auth posture at startup from the bind host and
 * environment. The caller (`src/server/start.ts`) turns this into log output
 * and, for `fail-closed`, a refusal to start.
 *
 * Precedence for a non-loopback bind:
 *  1. `KOOKR_API_TOKEN` set (non-empty)        → enforce that token.
 *  2. else `KOOKR_ALLOW_NON_LOOPBACK=true`     → auto-generate + enforce a token.
 *  3. else                                     → fail-closed; refuse to start.
 */
export type ApiAuthResolution =
  | { kind: 'loopback'; config: ApiAuthConfig }
  | { kind: 'token-provided'; config: ApiAuthConfig }
  | { kind: 'token-generated'; config: ApiAuthConfig; token: string }
  | { kind: 'fail-closed'; reason: string };

export interface ResolveApiAuthOptions {
  host: string | undefined;
  env: NodeJS.ProcessEnv;
  /** Test seam — defaults to a 32-byte hex token from `crypto.randomBytes`. */
  generateToken?: () => string;
}

function defaultGenerateToken(): string {
  return randomBytes(32).toString('hex');
}

export function resolveApiAuth(opts: ResolveApiAuthOptions): ApiAuthResolution {
  const { host, env } = opts;
  if (isLoopbackHost(host)) {
    return { kind: 'loopback', config: { required: false } };
  }

  const providedToken = env.KOOKR_API_TOKEN?.trim();
  if (providedToken) {
    return { kind: 'token-provided', config: { required: true, token: providedToken } };
  }

  const allowNonLoopback = env.KOOKR_ALLOW_NON_LOOPBACK?.trim().toLowerCase() === 'true';
  if (allowNonLoopback) {
    const token = (opts.generateToken ?? defaultGenerateToken)();
    return { kind: 'token-generated', config: { required: true, token }, token };
  }

  return {
    kind: 'fail-closed',
    reason:
      `Refusing to start: KOOKR_HOST=${host ?? '(unset)'} is a non-loopback bind but no API token is configured. ` +
      'Set KOOKR_API_TOKEN to a secret value, or set KOOKR_ALLOW_NON_LOOPBACK=true to auto-generate one at startup. ' +
      'A non-loopback bind without a token would expose full agent control to anyone who can reach the port.',
  };
}

/** Parse `Authorization: Bearer <token>` (case-insensitive scheme). */
export function extractBearerToken(headerValue: string | undefined | null): string | undefined {
  if (!headerValue) return undefined;
  const match = /^\s*Bearer\s+(\S.*?)\s*$/i.exec(headerValue);
  return match ? match[1] : undefined;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function tokenFromQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  const params = new URLSearchParams(url.slice(q + 1));
  return params.get('token') ?? params.get('api_token') ?? undefined;
}

/** Constant-time token comparison that tolerates length mismatch. */
export function tokensMatch(expected: string, presented: string | undefined | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Hono middleware enforcing the API token on state-changing requests. Safe
 * methods (GET/HEAD/OPTIONS) always pass through — the issue scopes the gate to
 * state-changing requests, and the live data feed is protected separately at
 * the WebSocket upgrade. When auth is not required (loopback bind) this is a
 * no-op pass-through.
 */
export function createApiAuthMiddleware(config: ApiAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!config.required || !config.token) return next();
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) return next();
    const presented =
      extractBearerToken(c.req.header('authorization')) ?? c.req.header(API_TOKEN_HEADER) ?? undefined;
    if (tokensMatch(config.token, presented)) return next();
    // Lowercase-hyphenated machine code, matching the existing auth-rejection
    // bodies in admin-routes.ts (`admin-forbidden`) and diagnostics-routes.ts.
    return c.json({ error: 'unauthorized' }, 401);
  };
}

/**
 * Authorize a raw WebSocket upgrade request. Browsers cannot set headers on the
 * `WebSocket` handshake, so a `?token=` query parameter is accepted alongside
 * the `Authorization`/`X-Kookr-Api-Token` headers. Returns true when auth is
 * not required (loopback bind).
 */
export function isAuthorizedUpgrade(
  config: ApiAuthConfig,
  req: { headers: IncomingHttpHeaders; url?: string | undefined },
): boolean {
  if (!config.required || !config.token) return true;
  const presented =
    extractBearerToken(firstHeaderValue(req.headers.authorization))
    ?? firstHeaderValue(req.headers[API_TOKEN_HEADER])
    ?? tokenFromQuery(req.url);
  return tokensMatch(config.token, presented);
}
