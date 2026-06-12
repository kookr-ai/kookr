// --- Browser auth: fragment → HttpOnly cookie exchange (RFC: rfc-shared-view-readonly.md
// §"Browser auth" + §"Transport security posture"; closes #708, R6/F4/F5) ---
//
// The handoff URL carries the raw token in the URL **fragment**
// (`https://<host>:<port>/#token=<raw>`), which a normal navigation never sends
// to the server. The SPA (`src/frontend/auth-session.ts`) reads `location.hash`
// and POSTs the token to `POST /api/auth/session`. This endpoint:
//
//   1. enforces a same-origin `Sec-Fetch-Site`/`Origin` check (login-CSRF /
//      session-fixation defense, F5) — it is the only route exempt from the
//      actor gate but is NOT exempt from this check;
//   2. validates the presented token (owner token, or — once the grant store is
//      wired live, coordinated with the WS read-only gate #806 — a viewer grant
//      via the `resolveViewer` seam);
//   3. sets the `HttpOnly; SameSite=Strict; Path=/` session cookie (with `Secure`
//      per the transport posture below), so the token is no longer readable by
//      JS and rides automatically on subsequent HTTP fetches and the WS upgrade
//      (no per-fetch edits, no token in any WS URL); and
//   4. returns a per-session CSRF nonce the SPA echoes back in `X-Kookr-CSRF` on
//      owner mutations (double-submit; viewers cannot mutate regardless, R3).
//
// Transport posture (RFC §"Transport security posture"): a `Secure` cookie is not
// sent over plain HTTP, which would silently break the exchange on the target
// `http://<tailnet-ip>` deployment. So `Secure` is set iff the request arrived
// over HTTPS; a non-Secure cookie is issued on plain HTTP **only** when the
// operator asserts a secure tunnel (`KOOKR_TRUSTED_TUNNEL=true`). On a
// non-loopback plain-HTTP bind without that assertion the exchange is refused
// (fail-closed) — we never ship a non-`Secure` cookie on an unasserted network.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import {
  API_TOKEN_HEADER,
  SESSION_COOKIE_NAME,
  classifyCredential,
  extractBearerToken,
  getOrCreateAuthThrottle,
  isBrowserSameOriginRequest,
  isLoopbackHost,
  parseCookieHeader,
  remoteAddrFromContext,
  type Actor,
  type ApiAuthConfig,
} from './auth.js';
import type { CollaborationAuditAppendInput } from './collaboration-audit-log.js';

/** Header carrying the per-session CSRF nonce on owner mutations (double-submit). */
export const CSRF_HEADER = 'x-kookr-csrf';

/** HTTP methods that never mutate state and so need no CSRF nonce. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Transport posture deciding *when* the cookie-exchange may issue a cookie,
 * resolved once at startup from the bind host + env (see
 * {@link resolveSessionTransport}). The dashboard server itself binds plain
 * HTTP (HTTPS is provided by a fronting tunnel such as Tailscale Serve, surfaced
 * per-request via `X-Forwarded-Proto`), so HTTPS can only be detected
 * per-request — the startup posture only decides whether a *plain-HTTP* exchange
 * is permitted.
 *
 *  - `loopback`        — loopback bind; auth is off entirely (R9), the feature is
 *    inert (the SPA never has a fragment token to exchange).
 *  - `trusted-tunnel`  — `KOOKR_TRUSTED_TUNNEL=true`: the operator asserts the
 *    bind sits behind a mesh-encrypted tunnel, so a non-`Secure` cookie may be
 *    issued over plain HTTP.
 *  - `https-required`  — non-loopback, no tunnel assertion: a cookie is issued
 *    only to an HTTPS request; a plain-HTTP exchange is refused (fail-closed).
 */
export type SessionTransportPosture =
  | { mode: 'loopback' }
  | { mode: 'trusted-tunnel' }
  | { mode: 'https-required' };

export function resolveSessionTransport(opts: {
  host: string | undefined;
  env: NodeJS.ProcessEnv;
}): SessionTransportPosture {
  if (isLoopbackHost(opts.host)) return { mode: 'loopback' };
  const trusted = opts.env.KOOKR_TRUSTED_TUNNEL?.trim().toLowerCase() === 'true';
  return trusted ? { mode: 'trusted-tunnel' } : { mode: 'https-required' };
}

/**
 * Operator-facing one-line summary of the resolved posture, logged once at
 * startup by `src/server/start.ts`. For `https-required` this is the
 * **fail-closed** notice that browser sessions over plain HTTP will be refused.
 */
export function describeSessionTransport(posture: SessionTransportPosture, host: string): string {
  switch (posture.mode) {
    case 'loopback':
      return '[auth] Loopback bind; browser session cookie exchange not required.';
    case 'trusted-tunnel':
      return (
        `[auth] Non-loopback bind (KOOKR_HOST=${host}); KOOKR_TRUSTED_TUNNEL=true — ` +
        'issuing the session cookie over the asserted secure tunnel (non-Secure on plain HTTP).'
      );
    case 'https-required':
      return (
        `[auth] Non-loopback bind (KOOKR_HOST=${host}) without HTTPS or KOOKR_TRUSTED_TUNNEL — ` +
        'browser session cookie exchange is REFUSED over plain HTTP (fail-closed). ' +
        'Front the dashboard with HTTPS (e.g. Tailscale Serve) or set KOOKR_TRUSTED_TUNNEL=true ' +
        'only if the bind sits behind a mesh-encrypted tunnel.'
      );
  }
}

/** Per-process CSRF HMAC secret. Generated once at startup. */
export function generateCsrfSecret(): Buffer {
  return randomBytes(32);
}

/**
 * Per-session CSRF nonce = HMAC-SHA256(secret, sessionToken). Binding the nonce
 * to the session token makes it per-session and stateless (no server-side store)
 * while never being a static per-process constant. The raw nonce is returned
 * only in the same-origin session response body and held in the SPA's memory
 * (not a JS-readable cookie), so a cross-site attacker cannot forge it.
 */
export function computeCsrfToken(secret: Buffer, sessionToken: string): string {
  return createHmac('sha256', secret).update(sessionToken, 'utf8').digest('hex');
}

/** Constant-time verification of a presented CSRF nonce against the expected one. */
export function verifyCsrfToken(secret: Buffer, sessionToken: string, presented: string | undefined | null): boolean {
  if (!presented) return false;
  const expected = createHmac('sha256', secret).update(sessionToken, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(presented, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Whether a request is same-origin, the login-CSRF / session-fixation defense
 * for the cookie exchange (F5). Prefers the `Sec-Fetch-Site` fetch-metadata
 * header (a same-origin SPA `fetch()` sends `same-origin`); when absent (older
 * browser / stripping proxy) it falls back to comparing the `Origin` host to the
 * request `Host`. Fail-closed: a state-changing POST with neither provenance
 * signal is rejected.
 */
export function isSameOriginRequest(headers: {
  secFetchSite?: string | null;
  origin?: string | null;
  host?: string | null;
}): boolean {
  // Only an exact same-origin request is accepted; 'same-site' (sibling
  // subdomain), 'cross-site', 'none' (cross-document / direct nav), and missing
  // browser provenance are not.
  return isBrowserSameOriginRequest(headers, {
    allowMissingHeaders: false,
    allowSecFetchSiteNone: false,
  });
}

/**
 * Serialize the session cookie. Always `HttpOnly; SameSite=Strict; Path=/`.
 *
 * The cookie *value* is the raw credential itself (the owner/viewer token), per
 * the #802 identity model where `resolveActor` reads the cookie as a presented
 * token — there is no separate opaque session id. It is `HttpOnly` (not
 * JS-readable) and `SameSite=Strict`. No `Max-Age`/`Expires` is set, so it is a
 * session cookie (cleared when the browser closes); grant expiry/revocation
 * (the server-side control) governs validity, not cookie lifetime.
 */
export function serializeSessionCookie(opts: { value: string; secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(opts.value)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Whether the request arrived over HTTPS (direct TLS or via a fronting tunnel).
 *
 * Trusts `X-Forwarded-Proto` because the dashboard binds plain HTTP and HTTPS is
 * supplied by a fronting tunnel (e.g. Tailscale Serve). This is sound under the
 * RFC threat model — the bind is reachable only on the mesh-encrypted tailnet,
 * not the public internet — so the header originates from the trusted front. A
 * spoofed `X-Forwarded-Proto: https` on a directly-reachable plain-HTTP port only
 * causes a `Secure` cookie to be issued, which the browser then will NOT send
 * back over plain HTTP — so the non-`Secure`-cookie fail-closed guarantee
 * (a non-Secure cookie is issued only in `trusted-tunnel` mode) still holds.
 */
function requestIsHttps(c: Context): boolean {
  const forwardedProto = c.req.header('x-forwarded-proto');
  if (forwardedProto) return forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Classify a token presented to the session endpoint as owner / viewer / invalid
 * via the shared {@link classifyCredential} (single owner of the matching). The
 * session endpoint validates the *presented* token (no loopback short-circuit),
 * and viewers resolve only via the injected `resolveViewer` seam — so until that
 * seam is wired live (with the WS read-only gate #806) this admits owner tokens
 * only, with no viewer fail-open onto the cookie / `/ws`.
 */
function classifyPresentedToken(config: ApiAuthConfig, token: string): Actor | null {
  return classifyCredential(config, token).actor;
}

/** Config threaded into the session route + CSRF middleware (from bootstrap). */
export interface SessionAuthConfig {
  /** Per-process CSRF HMAC secret. */
  csrfSecret: Buffer;
  /** Transport posture controlling when a cookie may be issued. */
  transport: SessionTransportPosture;
}

/**
 * Mount `POST /api/auth/session`. The route is the cookie exchange: it is the
 * only API route a viewer may reach, and the only one exempt from the actor gate
 * — but it enforces its own same-origin check and the transport posture.
 */
export function registerAuthSessionRoutes(
  app: Hono,
  deps: {
    apiAuth?: ApiAuthConfig;
    sessionAuth?: SessionAuthConfig;
    /**
     * Collaboration audit sink (#808 / R10). When present, a viewer cookie
     * exchange writes a `viewer-grant.session-established` event. Inert until the
     * `resolveViewer` security gate admits viewer tokens here (deferred — see the
     * SECURITY note at the top of this file), so today only owner exchanges occur
     * and no audit row is written. Owner exchanges are intentionally not audited
     * (the collaboration log tracks shared-view *viewers*, not the local owner).
     */
    auditLog?: { append: (input: CollaborationAuditAppendInput) => Promise<boolean> };
  },
): void {
  app.post('/api/auth/session', async (c) => {
    const sessionAuth = deps.sessionAuth;
    const apiAuth = deps.apiAuth;
    // Loopback / auth-off / unconfigured: the exchange is neither needed nor
    // possible (no owner token to validate against). Report it plainly.
    if (!sessionAuth || !apiAuth?.required || !apiAuth.token) {
      return c.json({ error: 'session-feature-disabled' }, 503);
    }

    // F5: same-origin check first, before any token handling.
    const sameOrigin = isSameOriginRequest({
      secFetchSite: c.req.header('sec-fetch-site'),
      origin: c.req.header('origin'),
      host: c.req.header('host'),
    });
    if (!sameOrigin) {
      console.warn(JSON.stringify({ event: 'auth_session_rejected', reason: 'cross_origin' }));
      return c.json({ error: 'cross-origin' }, 403);
    }

    // Transport posture: refuse to issue a cookie we cannot make safe.
    const https = requestIsHttps(c);
    if (!https && sessionAuth.transport.mode === 'https-required') {
      console.warn(JSON.stringify({ event: 'auth_session_rejected', reason: 'insecure_transport' }));
      return c.json(
        {
          error: 'insecure-transport',
          message:
            'Refusing to issue a non-Secure session cookie over plain HTTP. Use HTTPS (e.g. Tailscale Serve) ' +
            'or set KOOKR_TRUSTED_TUNNEL=true only if the bind sits behind a mesh-encrypted tunnel.',
        },
        400,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-body' }, 400);
    }
    const token = typeof (body as { token?: unknown })?.token === 'string'
      ? (body as { token: string }).token
      : '';
    if (!token) return c.json({ error: 'missing-token' }, 400);

    const remoteAddr = remoteAddrFromContext(c);
    const throttle = getOrCreateAuthThrottle(apiAuth);
    const lockedOut = throttle?.isLockedOut(remoteAddr) ?? false;
    const actor = classifyPresentedToken(apiAuth, token);
    if (!actor || lockedOut) {
      if (lockedOut) throttle?.recordThrottledAttempt(remoteAddr);
      else throttle?.recordFailure(remoteAddr, 'bad_token');
      console.warn(JSON.stringify({ event: 'auth_session_rejected', reason: lockedOut ? 'throttled' : 'invalid_token' }));
      return c.json({ error: 'invalid-token' }, 401);
    }
    if (actor.kind === 'owner') throttle?.reset(remoteAddr);

    // Secure iff the request actually arrived over HTTPS (posture above already
    // gated plain-HTTP without a tunnel assertion).
    c.header('Set-Cookie', serializeSessionCookie({ value: token, secure: https }), { append: true });
    const csrfToken = computeCsrfToken(sessionAuth.csrfSecret, token);

    // R10: audit a viewer establishing a session (owner exchanges are not
    // audited). Fire-and-forget — a slow/failed audit write must not block or
    // fail the cookie exchange the SPA depends on.
    if (actor.kind === 'viewer' && deps.auditLog) {
      void deps.auditLog
        .append({
          actor: { kind: 'viewer', grantId: actor.grantId },
          event: 'viewer-grant.session-established',
          grantId: actor.grantId,
        })
        .catch((err) => {
          console.warn('[auth-session] failed to write session-established audit event', err);
        });
    }

    return c.json({ ok: true, actor: actor.kind, csrfToken });
  });

  // --- Identity probe (whoami) for the SPA (#811, RFC §"Phase 3 UX") ---
  //
  // `GET /api/auth/session` returns the *current* actor resolved from the request
  // credential (the session cookie), so the SPA can render the read-only banner
  // and suppress mutation controls on every load — not only on the one boot where
  // a `#token` fragment was present. It is read-only, leaks only the caller's own
  // identity + scope, and is reachable by a viewer because the route path is on
  // the viewer HTTP allow-list (`isViewerAllowedRoute`); the actor gate already
  // 403s any *other* viewer route. On a loopback bind the actor gate is a no-op
  // (auth off) so `c.get('actor')` is unset — default to `owner`, which is correct
  // for the local owner and renders no banner.
  app.get('/api/auth/session', (c) => {
    const actor = c.get('actor') ?? ({ kind: 'owner' } as Actor);
    if (actor.kind === 'viewer') {
      return c.json({ actor: 'viewer', scope: actor.scope });
    }
    return c.json({ actor: 'owner' });
  });
}

/**
 * Double-submit CSRF guard for owner mutations (RFC §"Browser auth"). Applies
 * only on a non-loopback bind, only to mutating `/api/*` methods, and only when
 * the request is **cookie-authenticated** — a request bearing an
 * `Authorization`/`X-Kookr-Api-Token` header (the CLI) cannot be forged
 * cross-site and is exempt. The cookie-exchange route runs its own same-origin
 * check and is skipped here. Viewers cannot mutate regardless (R3); this protects
 * the owner's cookie session.
 *
 * `isExempt` lets the caller skip routes that already enforce their own CSRF
 * scheme on the same header name (the relay/contact-share family — see
 * `isShareGuardedRoute`), so the two schemes do not collide.
 */
export function createCsrfMiddleware(config: {
  apiAuth: ApiAuthConfig;
  csrfSecret: Buffer;
  isExempt?: (path: string) => boolean;
}): MiddlewareHandler {
  return async (c, next) => {
    if (!config.apiAuth.required) return next();
    const method = c.req.method.toUpperCase();
    if (SAFE_METHODS.has(method)) return next();
    const path = c.req.path;
    if (!path.startsWith('/api/')) return next();
    if (path === '/api/auth/session') return next();
    if (config.isExempt?.(path)) return next();

    const hasHeaderCred =
      !!extractBearerToken(c.req.header('authorization')) || !!c.req.header(API_TOKEN_HEADER);
    if (hasHeaderCred) return next();

    const cookieToken = parseCookieHeader(c.req.header('cookie'))[SESSION_COOKIE_NAME];
    // No cookie credential ⇒ the auth middleware already rejected (or will) this
    // request; CSRF has nothing to protect here.
    if (!cookieToken) return next();

    if (!verifyCsrfToken(config.csrfSecret, cookieToken, c.req.header(CSRF_HEADER))) {
      console.warn(JSON.stringify({ event: 'csrf_rejected', method, path }));
      return c.json({ error: 'csrf-failed' }, 403);
    }
    return next();
  };
}
