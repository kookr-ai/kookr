/**
 * Routability predicates re-exported from the shared task-routing contract
 * (#1079). The canonical definitions now live in `src/shared/task-routing.ts`
 * so the frontend (filtering, project-switch auto-select) and the server
 * (empty-Enter advancement) agree on exactly which tasks are routable. This
 * module is kept as a stable import surface for existing frontend callers.
 */
export { isActiveFinding, isHealthyRunning } from '../../shared/task-routing.js';
