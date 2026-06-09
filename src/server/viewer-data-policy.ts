// --- Viewer data policy (RFC: rfc-shared-view-readonly.md) ---
//
// The single source of truth for *what data a viewer may reach* across both
// enforcement loci: the HTTP viewer deny-list (`createApiAuthMiddleware` in
// `auth.ts`) and the WS scope filter (`buildScopedSnapshot`, Phase 2). Keeping
// `isViewerAllowedRoute` and `isProjectInScope` in one module — co-located with
// the `Scope` type they operate on — means the two loci cannot drift: a newly
// added data route is owner-only by default, and project-scope evaluation is
// computed identically on both channels (round-3 boundary fix).

/**
 * A viewer grant's scope. `projects.projectIds` is canonical: sorted and
 * deduped (see {@link canonicalizeScope}) so that `['A','B']` and `['B','A']`
 * compare and memoize identically downstream (RFC §Identity model).
 */
export type Scope =
  | { kind: 'all' }
  | { kind: 'projects'; projectIds: string[] };

/**
 * Normalize a `projects` scope to its canonical form (sorted + deduped). `all`
 * is returned unchanged. Callers that construct a scope from untrusted input
 * (the grant store, the share-create route) run it through here so the rest of
 * the system can rely on the canonical invariant.
 */
export function canonicalizeScope(scope: Scope): Scope {
  if (scope.kind === 'all') return scope;
  const projectIds = [...new Set(scope.projectIds)].sort();
  return { kind: 'projects', projectIds };
}

/**
 * Whether `projectId` is visible to a viewer holding `scope`. `all` sees
 * everything; a `projects` scope sees only its listed projects. This is the
 * single predicate the WS snapshot filter (Phase 2) and any future per-project
 * gate share, so HTTP and WS scope decisions cannot diverge.
 */
export function isProjectInScope(scope: Scope, projectId: string): boolean {
  if (scope.kind === 'all') return true;
  return scope.projectIds.includes(projectId);
}

/**
 * Phase-1 guard (#808): a `projects`-scoped grant is **not yet serviceable**
 * because the scope-filtered snapshot fan-out lands in Phase 2 (#809). Admitting
 * a `projects` viewer onto `/ws` now would either fail-closed (the broadcaster
 * stub throws) or, worse, silently over-deliver the full `all` snapshot. Until
 * #809 ships, the share-create route refuses to mint a `projects` grant and the
 * WS upgrade rejects one (503) if it ever resolves — so there is exactly one
 * predicate both loci consult and they cannot drift. Returns `true` when the
 * scope must be rejected in Phase 1.
 */
export function isPhase1UnsupportedViewerScope(scope: Scope): boolean {
  return scope.kind === 'projects';
}

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
