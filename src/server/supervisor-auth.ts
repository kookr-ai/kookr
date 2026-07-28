import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Scoped bearer-token gate for the supervisor remote-action endpoints (issue
 * #1526 Phase B / FM12, FM16 — see docs/reference/api.md "Supervisor
 * Surface"). Optional and off by default: when `KOOKR_SUPERVISOR_TOKEN` is
 * unset, gated routes stay exactly as open as every other local-first Kookr
 * API route. When set, callers must present `Authorization: Bearer <token>`
 * on the gated (mutating) routes; GETs are never gated.
 *
 * Unlike `KOOKR_ADMIN_TOKEN` (`src/server/routes/admin-routes.ts`), there is
 * no loopback bypass here — the whole point of this gate is that a caller
 * must present the token even from localhost, so a hallucinating local
 * process (the incident's local-model chat loop) can't freely drive
 * supervisor verbs just by running on the same box. This is deliberately not
 * a full auth system — no rotation, no per-caller tokens, no expiry.
 */

export const SUPERVISOR_TOKEN_ENV = 'KOOKR_SUPERVISOR_TOKEN';

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

export function isSupervisorTokenConfigured(): boolean {
  return Boolean(process.env[SUPERVISOR_TOKEN_ENV]?.trim());
}

/**
 * True when the request is authorized to call a supervisor-token-gated
 * route: either the gate is off (env unset) or the presented bearer token
 * matches, compared with a constant-time digest comparison.
 */
export function isAuthorizedSupervisorRequest(authorizationHeader: string | undefined | null): boolean {
  const configured = process.env[SUPERVISOR_TOKEN_ENV]?.trim();
  if (!configured) return true;
  const match = authorizationHeader ? BEARER_PREFIX.exec(authorizationHeader) : null;
  const presented = match?.[1]?.trim();
  if (!presented) return false;
  return timingSafeTokenEqual(configured, presented);
}

function timingSafeTokenEqual(expected: string, presented: string): boolean {
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}
