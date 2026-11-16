import type { Hono } from 'hono';
import { readOperatorInbox, type OperatorInboxDeps } from '../operator-inbox.js';

/**
 * `GET /api/operator/inbox` (issue #3931): everything waiting on the operator,
 * across every project, oldest first. Owner only: the API auth middleware
 * refuses a read-only viewer on every route that is not on its allow-list.
 */
export function registerOperatorInboxRoutes(app: Hono, deps: OperatorInboxDeps): void {
  app.get('/api/operator/inbox', (c) => c.json(readOperatorInbox(deps)));
}
