import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { MiddlewareHandler } from 'hono';
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
  /**
   * Viewer-grant lookup, injected from the grant store (#803). Given a raw
   * presented token that is *not* the owner token, classify it as a valid /
   * revoked / expired / unknown viewer grant. Absent ⇒ no viewer grants exist
   * (or the store is not wired yet), so any non-owner credential is rejected as
   * `bad_token`. Keeping this a seam lets #802 ship and be tested standalone.
   */
  resolveViewer?: (token: string) => ViewerTokenResolution;
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
    logAuthRejected(hadCookie ? 'cookie_missing' : 'no_credential', ctx.remoteAddr);
    return null;
  }

  const classified = classifyCredential(config, presented);
  if (classified.actor) return classified.actor;
  if (classified.reason === 'bad_token') {
    logAuthRejected('bad_token', ctx.remoteAddr);
  } else {
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
    if (!config.required || !config.token) return next();

    const method = c.req.method;
    const path = c.req.path;
    if (isUnauthenticatedRoute(method, path)) return next();

    const actor = resolveActor(config, {
      // The bind is non-loopback here (config.required); no trusted per-request
      // host to elevate from, so rely on config + presented credential.
      authorization: c.req.header('authorization'),
      apiTokenHeader: c.req.header(API_TOKEN_HEADER),
      cookies: parseCookieHeader(c.req.header('cookie')),
      remoteAddr: c.req.header('x-forwarded-for') ?? undefined,
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
