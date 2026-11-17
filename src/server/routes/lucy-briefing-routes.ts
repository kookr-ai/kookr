/**
 * GET /api/lucy/briefing: what Lucy writes to the operator when they open her panel or come back
 * to the dashboard. A few sentences on what waits on them, up to three follow-up requests to
 * press, and a signature the panel uses to avoid repeating itself.
 *
 * No model is called: the text comes from Kookr's own records and fixed sentence patterns
 * (`core/lucy-operator/operator-briefing.ts`). The route follows the operator conversation's
 * switch all the same, because the follow-up requests are typed turns of that conversation:
 * 404 when it is off, 503 when it is switched on but cannot run. Owner only, like every `/api` route.
 */
import type { Hono } from 'hono';
import { buildOperatorBriefing, type OperatorBriefingInput } from '../../core/lucy-operator/operator-briefing.js';
import type { LucyBriefingResponse } from '../../shared/contracts/lucy-briefing.js';
import type { LucyOperatorRouteDeps } from './lucy-operator-routes.js';

export interface LucyBriefingRouteDeps {
  /** The same value the turn route is given: absent when the conversation is off, without a `service` when it cannot run. */
  lucyOperator?: LucyOperatorRouteDeps['lucyOperator'];
  /** The tasks, why they wait and the questions, read fresh on every request. Absent in route-only harnesses: 404. */
  getInput?: () => OperatorBriefingInput;
  now?: () => number;
}

export function registerLucyBriefingRoutes(app: Hono, deps: LucyBriefingRouteDeps): void {
  // The path is written out (it is `LUCY_BRIEFING_PATH`): the route-documentation check resolves path
  // constants only inside `src/server`, so a constant from `shared/contracts` would go unchecked.
  app.get('/api/lucy/briefing', (c) => {
    if (!deps.lucyOperator || !deps.getInput) {
      return c.json({ error: 'lucy_operator_disabled', message: 'Lucy\'s conversation is off on this server, so she gives no briefing.' }, 404);
    }
    if (!deps.lucyOperator.service) {
      return c.json({ error: 'lucy_operator_unavailable', message: deps.lucyOperator.unavailableReason ?? 'Lucy\'s conversation is not available on this server.' }, 503);
    }
    const at = deps.now?.() ?? Date.now();
    const response: LucyBriefingResponse = { ...buildOperatorBriefing(deps.getInput(), at), at };
    c.header('Cache-Control', 'no-store');
    return c.json(response);
  });
}
