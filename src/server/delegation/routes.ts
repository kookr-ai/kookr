import type { Context, Hono } from 'hono';
import type { DelegationService, ServiceError } from './service.js';

/**
 * HTTP surface for Kookr→Hermes delegation (RFC section 5; slice 1a: API only).
 *
 *   POST /api/delegations              submit a typed job; 202 with the record, or a typed error
 *   GET  /api/delegations/:id          read one delegation
 *   GET  /api/delegations?parent=<id>  list delegations (optionally those of one parent task)
 *
 * There is no cancel or workers route yet (slice 2). The API is asynchronous only: a POST
 * returns the new record immediately; callers poll the GET route.
 *
 * The routes are ALWAYS registered (RFC section 5: disabled is observable, not a 404). With no
 * service (flag off, or configuration missing/invalid) every path answers a typed 503
 * `delegation_disabled` with a `reason` and contacts nothing; the caller of this function logs
 * why at startup. When a service exists but cannot work (for example its store file is
 * corrupt) the answer is the same 503 with reason `store_corrupt`, naming the file.
 *
 * Responses never contain worker URLs, token file paths, or tokens: the record carries
 * only the worker's name.
 */

const MAX_BODY_BYTES = 4096;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const LIST_LIMIT = 100;

/** Why delegation is not running (RFC section 5: disabled is observable, not a 404). */
export interface DelegationDisabledInfo {
  reason: 'flag_off' | 'no_config' | 'invalid_config';
  missing: string[];
}

export interface DelegationRouteDeps {
  /** Present only when delegation is opted in and configured. */
  delegationService?: DelegationService;
  /** Set when there is no service: the routes then answer 503 `delegation_disabled`. */
  delegationDisabled?: DelegationDisabledInfo;
  /** Clock seam for the rate limiter. */
  nowMs?: () => number;
}

export function registerDelegationRoutes(app: Hono, deps: DelegationRouteDeps): void {
  const service = deps.delegationService;
  if (!service) {
    // Always registered (RFC section 5): a caller can tell "disabled" from "broken". Nothing is
    // read, no worker is contacted. Reason codes: flag_off | no_config | invalid_config.
    const off = deps.delegationDisabled ?? { reason: 'flag_off' as const, missing: [] };
    const answer = (c: Context) =>
      c.json(
        { error: 'delegation_disabled', reason: off.reason, message: `delegation is disabled: ${off.reason}`, missing: off.missing },
        503,
      );
    app.post('/api/delegations', answer);
    app.get('/api/delegations', answer);
    app.get('/api/delegations/:id', answer);
    return;
  }
  const now = deps.nowMs ?? Date.now;
  const submissions: number[] = [];

  const rateLimited = (): boolean => {
    const t = now();
    while (submissions.length > 0 && t - submissions[0]! > RATE_WINDOW_MS) submissions.shift();
    if (submissions.length >= RATE_LIMIT) return true;
    submissions.push(t);
    return false;
  };

  const errorResponse = (c: Context, e: ServiceError) => {
    if (e.retryAfterSec !== undefined) c.header('Retry-After', String(e.retryAfterSec));
    return c.json(
      {
        error: e.code,
        message: e.message,
        ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}),
        ...(e.missing ? { missing: e.missing } : {}),
        ...(e.file ? { file: e.file } : {}),
      },
      e.httpStatus as 400,
    );
  };

  const disabled = (c: Context) => {
    const d = service.disabledInfo;
    if (!d) return undefined;
    const reason = d.reason.startsWith('store_') ? 'store_corrupt' : d.reason;
    return c.json(
      {
        error: 'delegation_disabled',
        reason,
        message: `delegation is disabled: ${reason}`,
        missing: d.missing,
        ...(d.file ? { file: d.file } : {}),
      },
      503,
    );
  };

  app.post('/api/delegations', async (c) => {
    const off = disabled(c);
    if (off) return off;
    // Ordered disable: refuse NEW submissions only; GETs and in-flight work keep working.
    if (!(await service.isAccepting())) {
      return c.json(
        { error: 'delegation_disabled', reason: 'not_accepting', message: 'delegation is not accepting new submissions', missing: [] },
        503,
      );
    }
    if (rateLimited()) {
      c.header('Retry-After', '60');
      return c.json({ error: 'rate_limited', message: 'too many delegation submissions', retryAfterSec: 60 }, 429);
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return c.json({ error: 'body_too_large', message: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);
    }
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return c.json({ error: 'invalid_request', message: 'malformed JSON' }, 400);
    }
    const result = await service.submit(body);
    if (!result.ok) return errorResponse(c, result.error);
    if (!result.created) return c.json({ delegation: result.delegation, idempotentReplay: true }, 200);
    return c.json({ delegation: result.delegation }, 202);
  });

  app.get('/api/delegations/:id', (c) => {
    const off = disabled(c);
    if (off) return off;
    const record = service.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found', message: 'no such delegation' }, 404);
    return c.json({ delegation: record });
  });

  app.get('/api/delegations', (c) => {
    const off = disabled(c);
    if (off) return off;
    const parent = c.req.query('parent');
    // `?active=1` keeps only non-terminal delegations (so the ordered-disable check "none
    // active" is exact even when more than LIST_LIMIT terminal records exist).
    const active = c.req.query('active');
    const rows = service
      .list({ ...(parent !== undefined ? { parent } : {}), ...(active === '1' || active === 'true' ? { activeOnly: true } : {}) })
      .slice(0, LIST_LIMIT);
    return c.json({ delegations: rows });
  });
}
