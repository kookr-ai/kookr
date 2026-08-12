// --- Terminal stream scope check (RFC: rfc-shared-view-readonly.md, Phase 2) ---
//
// A viewer's terminal stream (`/ws/terminal/:sessionName`) must be limited to
// sessions whose owning task is in the grant's project scope. This module is the
// **single owner of that decision**: it resolves the session → task → projectId
// mapping AND compares it against the actor's scope, so the terminal upgrade
// handler (`start-http-and-websockets.ts`) and the revocation sweep
// (`viewer-connection-registry.ts`) hold zero scope logic — they just call the
// injected predicate (RFC boundary goal, round 2).
//
// Fail-closed: an owner always passes; an `all`-scoped viewer passes; a
// `projects`-scoped viewer passes only when the session maps to an in-scope
// project. An unknown session, or a task with no project assignment, is denied —
// a viewer must never reach a terminal we cannot positively place in scope.

import type { Actor } from './auth.js';
import { isProjectInScope } from './viewer-data-policy.js';

/**
 * The terminal scope predicate injected into the upgrade handler and the
 * revocation sweep. `true` ⇒ the actor may attach to (or keep) this terminal
 * session; `false` ⇒ out-of-scope (403 at upgrade, eviction on a sweep tick).
 */
export type IsActorAllowedTerminalSession = (actor: Actor, sessionName: string) => boolean;

/**
 * Build the terminal scope predicate. `resolveSessionProjectId` maps a terminal
 * session name to the `projectId` of its owning task (production wires
 * `taskStore.viewTaskBySession(name)?.projectId`); it returns `undefined` when no
 * task owns the session or the task is unassigned to a project — both of which
 * are denied for a `projects`-scoped viewer.
 */
export function createTerminalScopeChecker(
  resolveSessionProjectId: (sessionName: string) => string | undefined,
): IsActorAllowedTerminalSession {
  return (actor, sessionName) => {
    // Owners are never scope-limited.
    if (actor.kind === 'owner') return true;
    // An `all` scope sees every session; no lookup needed.
    if (actor.scope.kind === 'all') return true;
    // `projects` scope: positively place the session in an in-scope project, or
    // deny. Unknown session / unassigned task ⇒ undefined ⇒ out of scope.
    const projectId = resolveSessionProjectId(sessionName);
    if (projectId === undefined) return false;
    return isProjectInScope(actor.scope, projectId);
  };
}
