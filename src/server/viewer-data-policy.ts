// --- Viewer data policy (RFC: rfc-shared-view-readonly.md) ---
//
// The single source of truth for *what data a viewer may reach* across both
// enforcement loci: the HTTP viewer deny-list (`createApiAuthMiddleware` in
// `auth.ts`) and the WS scope filter (`buildScopedSnapshot`, Phase 2). Pure
// scope types/helpers live in `core/viewer-scope` so the grant store can use
// them without a core→server import; this module re-exports those and owns the
// HTTP route allow-list only.

export {
  canonicalizeScope,
  isProjectInScope,
  type Scope,
} from '../core/viewer-scope.js';

/**
 * The viewer HTTP allow-list, matched on **pathname only** (R7, round-3 Issue
 * 4: no allow-listed route may carry a side-effecting query param). A viewer's
 * *only* permitted HTTP endpoint is the cookie-exchange session route; **all**
 * data-bearing routes — including `GET /api/health`, which leaks a global task
 * count and attached session names — are owner-only. Viewer data flows
 * exclusively through the scope-filtered WS snapshot and scope-checked terminal
 * streams. Default-deny: a route not listed here is denied to viewers.
 */
const VIEWER_ALLOWED_ROUTES: ReadonlySet<string> = new Set(['/api/auth/session']);

export function isViewerAllowedRoute(path: string): boolean {
  return VIEWER_ALLOWED_ROUTES.has(path);
}
