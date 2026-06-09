// --- Owner share control surface (RFC: rfc-shared-view-readonly.md §"Owner
// control surface (R8) + observability (R10)"; issue #808) ---
//
// Owner-only routes to create / list / revoke read-only viewer grants:
//
//   POST   /api/share/viewers           create → { grant, token, handoffUrl }   (token shown ONCE)
//   GET    /api/share/viewers           list   → { grants, roster }             (no raw tokens)
//   POST   /api/share/viewers/:id/revoke revoke → { ok: true }                   (sweep drops live sockets)
//
// These are gated owner-only by two layers already in place, so they need no
// per-route token check:
//   1. `createApiAuthMiddleware` (#802) requires an owner/viewer credential on
//      every `/api/*` route on a non-loopback bind, and **denies viewers** on
//      every route not in `VIEWER_ALLOWED_ROUTES` (which `/api/share/*` is not).
//   2. `createCsrfMiddleware` (#804) enforces the double-submit `x-kookr-csrf`
//      nonce on every cookie-authenticated mutation. NOTE: the sibling
//      `/api/share/*` routes self-enforce a *different* nonce
//      (`x-kookr-share-csrf`) and are exempted from that middleware via
//      `isShareGuardedRoute`. These viewer-share routes deliberately do NOT
//      self-enforce; instead `routes.ts` un-exempts them (via
//      {@link isViewerShareRoute}) so the standard `x-kookr-csrf` guard — which
//      the SPA's patched `fetch` attaches transparently — protects them. (A
//      header-credentialed CLI request is exempt; it cannot be forged cross-site.)
// A defensive viewer check is still kept here so a future routing change cannot
// silently expose the control surface to a viewer (defense in depth).
//
// Grant-minting guard: the create route accepts only `scope: all`. A `projects`
// grant is still refused (400) because project-scoped *sharing* is not yet
// end-to-end serviceable — #809 made the dashboard snapshot scope-correct, but
// the terminal scope check (#810) and the Share dialog scope picker (#811) are
// still pending. The WS-upgrade guard that previously mirrored this was removed
// in #809; scope is now enforced per-channel where the data is produced.

import type { Context, Hono } from 'hono';

import { canonicalizeScope, type Scope } from '../viewer-data-policy.js';
import type { RouteDeps } from './shared.js';

/**
 * Whether `path` is one of the owner viewer-share control-surface routes.
 * `routes.ts` uses this to *un-exempt* these routes from the share-family CSRF
 * exemption (`isShareGuardedRoute` matches the `/api/share/` prefix), so they
 * are protected by the standard `x-kookr-csrf` double-submit middleware instead
 * of the relay-family `x-kookr-share-csrf` scheme they do not implement.
 */
export function isViewerShareRoute(path: string): boolean {
  return path === '/api/share/viewers' || path.startsWith('/api/share/viewers/');
}

/** Build the fragment-carrier handoff URL for a freshly created token (#804). */
function buildHandoffUrl(c: Context, token: string): string {
  // Prefer the fronting proxy's protocol (Tailscale Serve terminates TLS and
  // sets X-Forwarded-Proto); fall back to the request URL's own scheme.
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  let proto = forwardedProto;
  let host = c.req.header('host') ?? '';
  if (!proto || !host) {
    try {
      const url = new URL(c.req.url);
      proto ||= url.protocol.replace(/:$/, '');
      host ||= url.host;
    } catch {
      proto ||= 'http';
    }
  }
  // The raw token rides in the URL **fragment** — never sent to the server on a
  // normal navigation; the SPA reads `location.hash` and exchanges it (#804).
  return `${proto}://${host}/#token=${encodeURIComponent(token)}`;
}

/** Whether the resolved actor is a viewer (defense-in-depth deny on the control surface). */
function isViewerActor(c: Context): boolean {
  return c.get('actor')?.kind === 'viewer';
}

/** Parse + validate the requested scope. Phase 1 admits only `all`. */
function parseRequestedScope(raw: unknown): { ok: true; scope: Scope } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, scope: { kind: 'all' } };
  if (typeof raw !== 'object') return { ok: false };
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === 'all') return { ok: true, scope: { kind: 'all' } };
  if (kind === 'projects') {
    const projectIds = (raw as { projectIds?: unknown }).projectIds;
    if (!Array.isArray(projectIds) || !projectIds.every((p) => typeof p === 'string')) {
      return { ok: false };
    }
    return { ok: true, scope: canonicalizeScope({ kind: 'projects', projectIds }) };
  }
  return { ok: false };
}

export function registerViewerShareRoutes(app: Hono, deps: RouteDeps): void {
  const share = deps.viewerShare;

  app.post('/api/share/viewers', async (c) => {
    if (!share) return c.json({ error: 'share-feature-disabled' }, 503);
    if (isViewerActor(c)) return c.json({ error: 'forbidden' }, 403);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const label = typeof (body as { label?: unknown })?.label === 'string'
      ? (body as { label: string }).label.trim()
      : '';

    const scopeResult = parseRequestedScope((body as { scope?: unknown })?.scope);
    if (!scopeResult.ok) {
      return c.json({ error: 'invalid-scope' }, 400);
    }
    // Grant-minting guard: only a whole-dashboard (`all`) grant is minted while
    // project-scoped *sharing* is still being built out (the scope picker is
    // #811 and the terminal scope check is #810). #809 made the dashboard
    // snapshot scope-correct (`buildScopedSnapshot`), but minting stays the
    // place to refuse *anything* not yet end-to-end serviceable — a strict
    // *allow-list* (`!== 'all'`) so any future scope kind is denied by default
    // rather than risk over-delivery.
    if (scopeResult.scope.kind !== 'all') {
      return c.json(
        {
          error: 'unsupported-scope',
          message:
            'Phase 1 supports only whole-dashboard viewer links (scope=all). '
            + 'Project-scoped sharing ships in a later phase.',
        },
        400,
      );
    }

    // Optional expiry; if present it must be a parseable ISO-8601 timestamp.
    const rawExpiresAt = (body as { expiresAt?: unknown })?.expiresAt;
    let expiresAt: string | undefined;
    if (rawExpiresAt !== undefined && rawExpiresAt !== null) {
      if (typeof rawExpiresAt !== 'string' || Number.isNaN(Date.parse(rawExpiresAt))) {
        return c.json({ error: 'invalid-expiry' }, 400);
      }
      expiresAt = rawExpiresAt;
    }

    const created = await share.grantStore.create({
      label: label || 'Viewer link',
      scope: scopeResult.scope,
      ...(expiresAt ? { expiresAt } : {}),
    });

    await share.auditLog.append({
      actor: { kind: 'local-owner' },
      event: 'viewer-grant.created',
      grantId: created.grant.id,
    });

    return c.json(
      {
        grant: created.grant,
        // The raw token is returned exactly once — it is never persisted or
        // re-derivable. The handoff URL embeds it in the fragment.
        token: created.token,
        handoffUrl: buildHandoffUrl(c, created.token),
      },
      201,
    );
  });

  app.get('/api/share/viewers', (c) => {
    if (!share) return c.json({ error: 'share-feature-disabled' }, 503);
    if (isViewerActor(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json({
      grants: share.grantStore.list(),
      roster: share.registry.viewerRoster(),
    });
  });

  app.post('/api/share/viewers/:id/revoke', async (c) => {
    if (!share) return c.json({ error: 'share-feature-disabled' }, 503);
    if (isViewerActor(c)) return c.json({ error: 'forbidden' }, 403);
    const id = c.req.param('id');
    const revoked = await share.grantStore.revoke(id);
    if (!revoked) return c.json({ error: 'grant-not-found' }, 404);

    await share.auditLog.append({
      actor: { kind: 'local-owner' },
      event: 'viewer-grant.revoked',
      grantId: id,
    });

    // Live sockets are dropped by the registry's revocation sweep on its next
    // tick (≤ sweepIntervalMs): the sweep reads `grantStore.liveness(id)`, now
    // `revoked`, and closes both pool sockets — emitting `viewer-grant.sweep-evicted`.
    return c.json({ ok: true });
  });
}
