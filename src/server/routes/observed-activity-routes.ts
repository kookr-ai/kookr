import type { Context, Hono } from 'hono';
import { timingSafeTokenEqual } from '../admin-token.js';
import {
  ObservedActivityStore,
  OBSERVED_LABEL_MAX,
  OBSERVED_PROVIDER,
  type ObservedState,
} from '../observed-activity-store.js';

/**
 * Hermes observed-activity bridge — slice 1 routes (jeanibarz/hermes-fleet#15,
 * RFC `rfc-hermes-observed-activity-bridge`).
 *
 * A dedicated, flag-gated, token-authenticated ingress for the operator's
 * external Hermes fleet. The ENTIRE lane state lives in the in-memory/durable
 * {@link ObservedActivityStore}; these routes are its only writer, which is what
 * makes the auth boundary and the visibility boundary the same boundary — a
 * process without the observer token cannot inject an observed entry, and the
 * ungated generic `/api/hook-event` route writes to the ledger/monitor, which
 * this lane never reads.
 *
 * Security posture (RFC §Security):
 * - Routes exist ONLY when `KOOKR_HERMES_FLEET` is on; otherwise 404 (R3).
 * - The observer token is REQUIRED on every call, INCLUDING loopback (loopback
 *   is not trusted on a shared/prod host — confused-deputy). Compared in
 *   constant time.
 * - If opted in but no token is configured, the routes FAIL LOUD: they are not
 *   registered, so the lane is never reachable without auth.
 * - `provider` is pinned server-side to `hermes-fleet`; never read from a body.
 */

const OBSERVER_TOKEN_HEADER = 'x-kookr-observer-token';
/** `hermes-obs-` (11) + 1..116 suffix chars = <=127, within the generic 128 cap. */
const OBSERVED_SESSION_ID_RE = /^hermes-obs-[A-Za-z0-9_-]{1,116}$/;
const MAX_BODY_BYTES = 4096;
const VALID_STATES: readonly ObservedState[] = ['working', 'idle', 'done'];

/**
 * Narrow dependency surface. The full {@link import('./shared.js').RouteDeps}
 * structurally satisfies it, so `routes.ts` passes `sharedDeps` unchanged while
 * tests build a 1-field harness.
 */
export interface ObservedActivityRouteDeps {
  /** `KOOKR_HERMES_FLEET` opt-in. When falsy, no routes are registered. */
  hermesFleetOptIn?: boolean;
  /** `KOOKR_HERMES_OBSERVER_TOKEN`. When absent while opted in, fail loud. */
  hermesObserverToken?: string;
  /** Pre-built store (production wires one that has `load()`-ed); else built here. */
  observedActivityStore?: ObservedActivityStore;
  /** Kookr state dir for the default store's durable file. */
  kookrDir: string;
}

interface ValidBody {
  sessionId: string;
  state: ObservedState;
  label?: string;
  ts: number;
}

type ValidationResult = { ok: true; value: ValidBody } | { ok: false; reason: string };

export function registerObservedActivityRoutes(app: Hono, deps: ObservedActivityRouteDeps): void {
  // Flag OFF ⇒ register nothing; every endpoint 404s, behavior unchanged (R3).
  if (!deps.hermesFleetOptIn) return;

  const token = deps.hermesObserverToken?.trim();
  if (!token) {
    // Opted in but unauthenticated-able: refuse to register and say why (R7 /
    // §Security "fail loud on missing token"). Returning here leaves the routes
    // 404 — identical to flag-off — so the lane is never reachable without auth.
    console.warn(
      '[hermes-observed-activity] KOOKR_HERMES_FLEET is ON but KOOKR_HERMES_OBSERVER_TOKEN ' +
        'is unset — observed-activity routes NOT registered (fail-closed). ' +
        'Set the token to enable the lane.',
    );
    return;
  }

  const store = deps.observedActivityStore ?? new ObservedActivityStore(deps.kookrDir);

  const authorized = (c: Context): boolean =>
    timingSafeTokenEqual(token, c.req.header(OBSERVER_TOKEN_HEADER));

  // Ingest one observed pulse.
  app.post('/api/observed-activity/hermes-fleet', async (c) => {
    if (!authorized(c)) {
      store.recordRejection('unauthorized');
      return c.json({ error: 'unauthorized' }, 401);
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      store.recordRejection('too_large');
      return c.json({ error: 'body too large' }, 413);
    }
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      store.recordRejection('malformed');
      return c.json({ error: 'malformed json' }, 400);
    }
    const parsed = validateBody(body);
    if (!parsed.ok) {
      store.recordRejection(parsed.reason);
      return c.json({ error: parsed.reason }, 400);
    }
    try {
      const outcome = await store.record(parsed.value);
      return c.json({ status: 'received', outcome, provider: OBSERVED_PROVIDER });
    } catch (err) {
      if (err instanceof RangeError) {
        store.recordRejection('rate_limited');
        return c.json({ error: 'rate limited' }, 429);
      }
      throw err;
    }
  });

  // Operator-facing transport + lane state (R7): counters distinguish "Hermes
  // idle" from "bridge rejecting", and the snapshot carries decayed states.
  app.get('/api/observed-activity/hermes-fleet/status', async (c) => {
    if (!authorized(c)) {
      store.recordRejection('unauthorized');
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json(await store.snapshot());
  });

  // Self-test / re-sync: lets the Hermes loop confirm auth + routing (and learn
  // the route is back after a deploy) so it can re-announce its current state.
  app.post('/api/observed-activity/hermes-fleet/ping', (c) => {
    if (!authorized(c)) {
      store.recordRejection('unauthorized');
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json({ ok: true, now: Date.now() });
  });
}

function validateBody(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'invalid_body' };
  const b = body as Record<string, unknown>;
  if (typeof b.sessionId !== 'string' || !OBSERVED_SESSION_ID_RE.test(b.sessionId)) {
    return { ok: false, reason: 'invalid_session_id' };
  }
  if (!VALID_STATES.includes(b.state as ObservedState)) {
    return { ok: false, reason: 'invalid_state' };
  }
  if (b.label !== undefined && (typeof b.label !== 'string' || b.label.length > OBSERVED_LABEL_MAX)) {
    return { ok: false, reason: 'invalid_label' };
  }
  if (typeof b.ts !== 'number' || !Number.isFinite(b.ts)) {
    return { ok: false, reason: 'invalid_ts' };
  }
  return {
    ok: true,
    value: {
      sessionId: b.sessionId,
      state: b.state as ObservedState,
      label: b.label as string | undefined,
      ts: b.ts,
    },
  };
}
