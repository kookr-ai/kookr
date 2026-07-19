// --- Viewer scope + token resolution (pure domain) ---
//
// Lives in `core/` so the grant store and auth seams share one SSOT without
// `core` importing `server`. Server modules re-export these symbols from
// `viewer-data-policy` / `auth` for existing import paths.

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
 * single predicate the WS snapshot filter and any future per-project gate share,
 * so HTTP and WS scope decisions cannot diverge.
 */
export function isProjectInScope(scope: Scope, projectId: string): boolean {
  if (scope.kind === 'all') return true;
  return scope.projectIds.includes(projectId);
}

/**
 * Result of looking a presented credential up against the viewer-grant store.
 * `resolveActor` / `ApiAuthConfig.resolveViewer` consume this shape so auth can
 * stay unit-testable without owning the store. `not-found` means the credential
 * is not a known viewer token (and was already shown not to be the owner token).
 */
export type ViewerTokenResolution =
  | { kind: 'valid'; grantId: string; scope: Scope }
  | { kind: 'revoked'; grantId: string }
  | { kind: 'expired'; grantId: string }
  | { kind: 'not-found' };
