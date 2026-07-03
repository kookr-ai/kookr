import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { AuthThrottle, type AuthThrottleRejectReason, type AuthThrottleSnapshot } from './auth-throttle.js';
import { isViewerAllowedRoute, type Scope } from './viewer-data-policy.js';

export type { Scope } from './viewer-data-policy.js';

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

// --- Actor/Scope identity model (RFC: rfc-shared-view-readonly.md §Identity) ---
//
// `Actor` is the single source of truth for read-only-shared-view enforcement
// and scope filtering across HTTP and WS. It is deliberately NOT unified with
// the relay-path `OwnerIdentity` above: that type identifies the *local owner*
// for the collaboration/relay rendezvous stack, whereas `Actor` classifies an
// *inbound dashboard request* on a (possibly non-loopback) bind. The two model
// different boundaries and are kept separate on purpose.
//
//   - Loopback bind ⇒ owner (hot path untouched, R9 — no token, no cookie).
//   - Owner token/cookie ⇒ owner. Viewer token/cookie ⇒ viewer + scope.
//   - No/invalid/revoked/expired credential on a non-loopback bind ⇒ null
//     (fail-closed).
export type Actor =
  | { kind: 'owner' }
  | { kind: 'viewer'; grantId: string; scope: Scope };

// Make `c.set('actor', …)` / `c.get('actor')` type-safe on **every** Hono
// instance app-wide via the framework's `ContextVariableMap` augmentation,
// rather than threading a `Hono<Env>` type parameter through all ~20
// `register*Routes` signatures (which would not be assignable to their plain
// `Hono` params). `actor` is set by the actor-aware API middleware; it is absent
// on loopback binds (the middleware is not installed) and on unauthenticated
// allow-list routes, so the value is optional.
declare module 'hono' {
  interface ContextVariableMap {
    actor?: Actor;
  }
}

/**
 * Result of looking a presented credential up against the viewer-grant store.
 * The store itself lands in #803; `resolveActor` consumes this via the injected
 * {@link ApiAuthConfig.resolveViewer} seam so this issue (#802) is complete and
 * unit-testable without the store. `not-found` means the credential is not a
 * known viewer token (and was already shown not to be the owner token).
 */
export type ViewerTokenResolution =
  | { kind: 'valid'; grantId: string; scope: Scope }
  | { kind: 'revoked'; grantId: string }
  | { kind: 'expired'; grantId: string }
  | { kind: 'not-found' };

// --- Bind-host classification + API token authentication (issue #708) ---
//
// When the dashboard binds to a non-loopback host (a LAN IP or 0.0.0.0), full
// agent control — task launch, stop, terminal input — is reachable by anyone
// who can hit the port. This module adds a deterministic, fail-closed bearer
// token gate that is enforced on state-changing HTTP requests and on the
// WebSocket upgrade ONLY when the bind host is non-loopback. Loopback binds
// (the default `127.0.0.1`) stay completely token-free.

/**
 * Header an HTTP/WS client (e.g. the CLI) may use to present a token in addition
 * to the standard `Authorization: Bearer <token>` form. Browsers cannot set
 * arbitrary headers on a `WebSocket` handshake; the browser path authenticates
 * via the session cookie instead (see {@link SESSION_COOKIE_NAME}). The legacy
 * `?token=` WS query branch is removed (R7/F4) — no token rides in a WS URL.
 */
export const API_TOKEN_HEADER = 'x-kookr-api-token';

/**
 * Name of the HttpOnly session cookie the browser presents on HTTP fetches and
 * the WS upgrade. The cookie *exchange* endpoint that sets it lands in #804;
 * `resolveActor` already reads it here so the credential plumbing is in place.
 */
export const SESSION_COOKIE_NAME = 'kookr_session';

export const MIN_OPERATOR_API_TOKEN_LENGTH = 24;

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
 * server is on a loopback bind and local clients need no credential; browser
 * provenance headers are still checked on mutating HTTP routes and WS upgrades.
 * `required: true` carries the single expected bearer token.
 */
export interface ApiAuthConfig {
  required: boolean;
  token?: string;
  /**
   * Emergency escape hatch for loopback browser-origin enforcement. The default
   * token-free loopback path still resolves the local owner without credentials,
   * but browser-initiated mutations/upgrades must be same-origin unless this is
   * explicitly set.
   */
  originGateDisabled?: boolean;
  /**
   * Viewer-grant lookup, injected from the grant store (#803). Given a raw
   * presented token that is *not* the owner token, classify it as a valid /
   * revoked / expired / unknown viewer grant. Absent ⇒ no viewer grants exist
   * (or the store is not wired yet), so any non-owner credential is rejected as
   * `bad_token`. Keeping this a seam lets #802 ship and be tested standalone.
   */
  resolveViewer?: (token: string) => ViewerTokenResolution;
  /**
   * Shared per-source throttle for failed credential attempts. The same
   * `ApiAuthConfig` instance is threaded into HTTP middleware and the raw WS
   * upgrade gate, so this state covers both paths.
   */
  authThrottle?: AuthThrottle;
}

/**
 * Outcome of resolving the API-auth posture at startup from the bind host and
 * environment. The caller (`src/server/start.ts`) turns this into log output
 * and, for `fail-closed`, a refusal to start.
 *
 * Precedence for a non-loopback bind:
 *  1. `KOOKR_API_TOKEN` set (non-empty)        → enforce that token when it is strong enough.
 *  2. else `KOOKR_ALLOW_NON_LOOPBACK=true`     → auto-generate + enforce a token.
 *  3. else                                     → fail-closed; refuse to start.
 */
export type ApiAuthResolution =
  | { kind: 'loopback'; config: ApiAuthConfig }
  | { kind: 'token-provided'; config: ApiAuthConfig; weakTokenAllowed?: true }
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
  const originGateDisabled = env.KOOKR_DISABLE_ORIGIN_GATE?.trim().toLowerCase() === 'true';
  if (isLoopbackHost(host)) {
    return { kind: 'loopback', config: { required: false, originGateDisabled } };
  }

  const providedToken = env.KOOKR_API_TOKEN?.trim();
  if (providedToken) {
    if (providedToken.length < MIN_OPERATOR_API_TOKEN_LENGTH) {
      const allowWeakApiToken = env.KOOKR_ALLOW_WEAK_API_TOKEN?.trim().toLowerCase() === 'true';
      if (!allowWeakApiToken) {
        return {
          kind: 'fail-closed',
          reason:
            `Refusing to start: KOOKR_HOST=${host ?? '(unset)'} is a non-loopback bind but KOOKR_API_TOKEN is too short. ` +
            `Use at least ${MIN_OPERATOR_API_TOKEN_LENGTH} characters, or set KOOKR_ALLOW_WEAK_API_TOKEN=true to accept ` +
            'the weak token for this run. A short token can be brute-forced by anyone who can reach the port.',
        };
      }
      return {
        kind: 'token-provided',
        config: { required: true, token: providedToken, originGateDisabled },
        weakTokenAllowed: true,
      };
    }
    return { kind: 'token-provided', config: { required: true, token: providedToken, originGateDisabled } };
  }

  const allowNonLoopback = env.KOOKR_ALLOW_NON_LOOPBACK?.trim().toLowerCase() === 'true';
  if (allowNonLoopback) {
    const token = (opts.generateToken ?? defaultGenerateToken)();
    return { kind: 'token-generated', config: { required: true, token, originGateDisabled }, token };
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

/** Constant-time token comparison that tolerates length mismatch. */
export function tokensMatch(expected: string, presented: string | undefined | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Minimal `Cookie:` header parser (name → value). Avoids a dependency so both
 * the Hono HTTP path and the raw WS upgrade path share one implementation. Only
 * the first occurrence of a name wins; values are URL-decoded best-effort.
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // leave the raw value if it is not valid percent-encoding
    }
    out[name] = value;
  }
  return out;
}

/** Reason an actor was rejected/denied (structured-log + observability, R10). */
export type AuthRejectReason =
  | 'no_credential'
  | 'cookie_missing'
  | 'bad_token'
  | 'revoked'
  | 'expired'
  | 'cross_origin'
  | 'throttled'
  /** A *valid* viewer credential hit an owner-only route (viewer GET deny-list). */
  | 'viewer_route_denied';

/**
 * Structured auth-rejection log (R10). Emitted on every failed actor resolution
 * so a non-loopback deployment can see *why* a request was denied without
 * leaking the presented secret. Uses `console.warn` to match the bootstrap
 * logging convention in this server (`start-http-and-websockets.ts`).
 */
function logAuthRejected(reason: AuthRejectReason, remoteAddr: string | undefined, grantId?: string): void {
  console.warn(
    JSON.stringify({ event: 'auth_rejected', reason, remoteAddr: remoteAddr ?? null, ...(grantId ? { grantId } : {}) }),
  );
}

export function getOrCreateAuthThrottle(config: ApiAuthConfig): AuthThrottle | undefined {
  if (!config.required || !config.token) return undefined;
  config.authThrottle ??= new AuthThrottle();
  return config.authThrottle;
}

export function getAuthThrottleSnapshot(config: ApiAuthConfig | undefined): AuthThrottleSnapshot {
  return (config?.authThrottle ?? new AuthThrottle()).snapshot();
}

export function remoteAddrFromContext(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address ?? c.req.header('x-forwarded-for') ?? undefined;
  } catch {
    return c.req.header('x-forwarded-for') ?? undefined;
  }
}

export interface BrowserOriginHeaders {
  secFetchSite?: string | null;
  origin?: string | null;
  host?: string | null;
}

/**
 * Browser-origin guard used by the token-free loopback owner hot path.
 *
 * Browsers send either Fetch Metadata (`Sec-Fetch-Site`) or an `Origin` header
 * on the CSRF/CSWSH shapes this protects. Non-browser clients such as curl,
 * CLIs, and hooks usually send neither, so absence is allowed here. The stricter
 * cookie-session exchange wraps this with absence/`none` denied.
 */
export function isBrowserSameOriginRequest(
  headers: BrowserOriginHeaders,
  opts: { allowMissingHeaders: boolean; allowSecFetchSiteNone: boolean },
): boolean {
  const secFetchSite = headers.secFetchSite?.trim().toLowerCase();
  if (secFetchSite) {
    return secFetchSite === 'same-origin'
      || (opts.allowSecFetchSiteNone && secFetchSite === 'none');
  }
  if (headers.origin) {
    try {
      const originUrl = new URL(headers.origin);
      return !!headers.host && originUrl.host === headers.host;
    } catch {
      return false;
    }
  }
  return opts.allowMissingHeaders;
}

function hostnameFromHostHeader(host: string | null | undefined): string | undefined {
  const normalized = host?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith('[')) {
    const end = normalized.indexOf(']');
    return end > 0 ? normalized.slice(1, end) : normalized;
  }
  const colonCount = normalized.split(':').length - 1;
  if (colonCount === 1) return normalized.split(':', 1)[0];
  return normalized;
}

function isLoopbackHostHeader(host: string | null | undefined): boolean {
  return isLoopbackHost(hostnameFromHostHeader(host));
}

export function isLoopbackBrowserOriginAllowed(headers: BrowserOriginHeaders): boolean {
  const hasBrowserSignal = !!headers.secFetchSite?.trim() || !!headers.origin;
  if (hasBrowserSignal && !isLoopbackHostHeader(headers.host)) return false;
  return isBrowserSameOriginRequest(headers, {
    allowMissingHeaders: true,
    allowSecFetchSiteNone: true,
  });
}

function loopbackOriginGateApplies(config: ApiAuthConfig): boolean {
  return !config.originGateDisabled && (!config.required || !config.token);
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

function isMutatingMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

function shouldEnforceLoopbackHttpOriginGate(
  config: ApiAuthConfig,
  req: { method: string; path: string },
): boolean {
  return loopbackOriginGateApplies(config)
    && isMutatingMethod(req.method)
    && isApiPath(req.path);
}

export function isLoopbackUpgradeOriginAllowed(
  config: ApiAuthConfig,
  req: { headers: IncomingHttpHeaders },
): boolean {
  if (!loopbackOriginGateApplies(config)) return true;
  return isLoopbackBrowserOriginAllowed({
    secFetchSite: firstHeaderValue(req.headers['sec-fetch-site']),
    origin: firstHeaderValue(req.headers.origin),
    host: firstHeaderValue(req.headers.host),
  });
}

/**
 * Inputs to {@link resolveActor}. Transport-neutral: the Hono middleware and the
 * raw WS-upgrade path each normalize their request into this shape.
 *
 * `host` is the **bind host** (trusted, not a client header); a loopback bind
 * resolves to owner with no credential (R9). The HTTP credential search order is
 * `Authorization: Bearer` → `X-Kookr-Api-Token` header → session cookie. No
 * credential is ever read from the query string (R7/F4).
 */
export interface ActorResolutionContext {
  /** Trusted bind host. Loopback ⇒ owner. */
  host?: string | null;
  /** `Authorization` header value, if any. */
  authorization?: string;
  /** `X-Kookr-Api-Token` header value (CLI parity), if any. */
  apiTokenHeader?: string;
  /** Parsed cookies (name → value). */
  cookies?: Record<string, string | undefined>;
  /** Remote address, for the structured rejection log only. */
  remoteAddr?: string;
}

/**
 * Classify an already-extracted *credential string* (from a header, cookie, or
 * request body) as owner / viewer / rejected, WITHOUT the loopback short-circuit
 * or structured logging of {@link resolveActor}. This is the single owner of the
 * owner-token-then-viewer-grant matching, shared by `resolveActor` (HTTP/WS
 * gate) and the `POST /api/auth/session` cookie-exchange route (#804) so the two
 * cannot drift. The caller decides what to log and how loopback maps to owner.
 */
export type CredentialClassification =
  | { actor: Actor }
  | { actor: null; reason: 'bad_token' }
  | { actor: null; reason: 'revoked' | 'expired'; grantId: string };

export function classifyCredential(config: ApiAuthConfig, presented: string): CredentialClassification {
  if (config.token && tokensMatch(config.token, presented)) return { actor: { kind: 'owner' } };
  const viewer = config.resolveViewer?.(presented) ?? { kind: 'not-found' as const };
  switch (viewer.kind) {
    case 'valid':
      return { actor: { kind: 'viewer', grantId: viewer.grantId, scope: viewer.scope } };
    case 'revoked':
      return { actor: null, reason: 'revoked', grantId: viewer.grantId };
    case 'expired':
      return { actor: null, reason: 'expired', grantId: viewer.grantId };
    case 'not-found':
      return { actor: null, reason: 'bad_token' };
  }
}

/**
 * Resolve the {@link Actor} for an inbound request/upgrade, or `null` when the
 * credential is missing/invalid on a non-loopback bind (fail-closed). This is
 * the single classification point shared by the HTTP middleware and the WS
 * upgrade gate.
 *
 * Order: loopback (or auth-not-required) ⇒ owner; else extract a credential
 * (bearer → api-token header → session cookie); the owner token ⇒ owner; else
 * the injected viewer lookup classifies it; anything unresolved ⇒ `null` with a
 * structured rejection log.
 */
export function resolveActor(config: ApiAuthConfig, ctx: ActorResolutionContext): Actor | null {
  // R9: loopback / auth-not-required ⇒ owner, hot path untouched.
  if (!config.required || !config.token) return { kind: 'owner' };
  if (isLoopbackHost(ctx.host)) return { kind: 'owner' };
  const throttle = getOrCreateAuthThrottle(config);
  const source = ctx.remoteAddr;
  const lockedOut = throttle?.isLockedOut(source) ?? false;

  const presented =
    extractBearerToken(ctx.authorization)
    ?? ctx.apiTokenHeader
    ?? ctx.cookies?.[SESSION_COOKIE_NAME]
    ?? undefined;

  if (!presented) {
    // Distinguish "a cookie was sent but not ours" from "nothing presented at
    // all" only coarsely: a browser request carrying some cookie but no
    // credential is the common #804 failure mode worth its own reason.
    const hadCookie = !!ctx.cookies && Object.keys(ctx.cookies).length > 0;
    const reason = hadCookie ? 'cookie_missing' : 'no_credential';
    if (lockedOut) throttle?.recordThrottledAttempt(source);
    else throttle?.recordFailure(source, reason);
    logAuthRejected(lockedOut ? 'throttled' : reason, ctx.remoteAddr);
    return null;
  }

  const classified = classifyCredential(config, presented);
  if (classified.actor) {
    if (lockedOut) {
      throttle?.recordThrottledAttempt(source);
      logAuthRejected('throttled', ctx.remoteAddr);
      return null;
    }
    if (classified.actor.kind === 'owner') throttle?.reset(source);
    return classified.actor;
  }
  if (lockedOut) {
    throttle?.recordThrottledAttempt(source, classified.reason as AuthThrottleRejectReason);
    logAuthRejected('throttled', ctx.remoteAddr);
  } else if (classified.reason === 'bad_token') {
    throttle?.recordFailure(source, 'bad_token');
    logAuthRejected('bad_token', ctx.remoteAddr);
  } else {
    throttle?.recordFailure(source, classified.reason);
    logAuthRejected(classified.reason, ctx.remoteAddr, classified.grantId);
  }
  return null;
}

/**
 * Whether a request needs no credential at all, matched on **pathname only**
 * (R7, round-3 Issue 4 — no allow-listed route may carry a side-effecting query
 * param). The unauthenticated set is: every non-`/api` path (static SPA assets +
 * client-side routes), the cookie-exchange endpoint `POST /api/auth/session`,
 * and the liveness probe `GET /api/ready`. Everything else under `/api` requires
 * an owner or viewer credential. The `/api` prefix is checked first so this can
 * never shadow an API route.
 *
 * This is a *different* concern from {@link isViewerAllowedRoute} and the two are
 * deliberately not merged: this answers "skip auth entirely?", that answers "may
 * an already-authenticated viewer reach this route?". They both happen to name
 * `POST /api/auth/session` (it is both unauthenticated *and* a viewer's only
 * route), but a new route added to one must NOT be assumed to belong in the
 * other.
 */
export function isUnauthenticatedRoute(method: string, path: string): boolean {
  const isApi = path === '/api' || path.startsWith('/api/');
  if (!isApi) return true; // static SPA assets + client routes
  const m = method.toUpperCase();
  if (m === 'POST' && path === '/api/auth/session') return true;
  if (m === 'GET' && path === '/api/ready') return true;
  return false;
}

/**
 * Actor-aware Hono middleware (RFC R7). When auth is not required (loopback
 * bind) this is a no-op pass-through (R9). Otherwise, on a non-loopback bind:
 *
 *  - The unauthenticated allow-list (static assets, `POST /api/auth/session`,
 *    `GET /api/ready`) passes through with no credential.
 *  - **Every** other API method — including GET — needs a credential; the
 *    safe-method bypass is removed (R7). `null` actor ⇒ 401.
 *  - A `viewer` is denied (403) on all API data routes; its only permitted HTTP
 *    endpoint is `POST /api/auth/session` (already allow-listed above). Viewer
 *    data flows only via the scope-filtered WS channel.
 *  - `owner` passes; the resolved actor is attached via `c.set('actor', …)`.
 */
export function createApiAuthMiddleware(config: ApiAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;

    if (shouldEnforceLoopbackHttpOriginGate(config, { method, path })) {
      const sameOrigin = isLoopbackBrowserOriginAllowed({
        secFetchSite: c.req.header('sec-fetch-site'),
        origin: c.req.header('origin'),
        host: c.req.header('host'),
      });
      if (!sameOrigin) {
        logAuthRejected('cross_origin', c.req.header('x-forwarded-for') ?? undefined);
        return c.json({ error: 'cross-origin' }, 403);
      }
    }

    if (!config.required || !config.token) return next();

    if (isUnauthenticatedRoute(method, path)) return next();

    const remoteAddr = remoteAddrFromContext(c);

    const actor = resolveActor(config, {
      // The bind is non-loopback here (config.required); no trusted per-request
      // host to elevate from, so rely on config + presented credential.
      authorization: c.req.header('authorization'),
      apiTokenHeader: c.req.header(API_TOKEN_HEADER),
      cookies: parseCookieHeader(c.req.header('cookie')),
      remoteAddr,
    });

    // Lowercase-hyphenated machine codes match the existing auth-rejection
    // bodies in admin-routes.ts (`admin-forbidden`) and diagnostics-routes.ts.
    if (!actor) return c.json({ error: 'unauthorized' }, 401);

    if (actor.kind === 'viewer' && !isViewerAllowedRoute(path)) {
      logAuthRejected('viewer_route_denied', c.req.header('x-forwarded-for') ?? undefined, actor.grantId);
      return c.json({ error: 'forbidden' }, 403);
    }

    c.set('actor', actor);
    return next();
  };
}

/**
 * Resolve the {@link Actor} for a raw WebSocket upgrade request, or `null` when
 * unauthorized (R7/F4). Browsers cannot set headers on the `WebSocket`
 * handshake, so the browser authenticates via the **session cookie** parsed
 * from the `Cookie:` header; the `Authorization`/`X-Kookr-Api-Token` headers
 * remain for CLI clients. The legacy `?token=` query branch is removed so no
 * token rides in a WS URL.
 */
export function resolveUpgradeIdentity(
  config: ApiAuthConfig,
  req: { headers: IncomingHttpHeaders; url?: string | undefined; socket?: { remoteAddress?: string } },
): Actor | null {
  return resolveActor(config, {
    authorization: firstHeaderValue(req.headers.authorization),
    apiTokenHeader: firstHeaderValue(req.headers[API_TOKEN_HEADER]),
    cookies: parseCookieHeader(firstHeaderValue(req.headers.cookie)),
    remoteAddr: req.socket?.remoteAddress,
  });
}

/**
 * Back-compat shim (reversible migration): authorize a WS upgrade as a boolean.
 * Parity with {@link resolveUpgradeIdentity} — true iff an actor resolves —
 * except the deliberately-removed `?token=` query branch (R7/F4).
 */
export function isAuthorizedUpgrade(
  config: ApiAuthConfig,
  req: { headers: IncomingHttpHeaders; url?: string | undefined },
): boolean {
  return resolveUpgradeIdentity(config, req) !== null;
}
