import { SUPERVISOR_ACTOR_HEADER, UNATTRIBUTED_ACTOR_ID } from '../shared/contracts/supervisor-actions.js';

/**
 * Resolves and attributes the caller of a mutating task-lifecycle action for
 * forensics (issue #1526 Phase B — postmortem of the 2026-07-24 deadlock).
 * `audit.jsonl` batch-abort rows during that incident all carried
 * `actor: { source: 'api' }` with no caller id, so it was impossible to tell
 * from the durable trail alone whether Jean or a self-aborting agent issued
 * the four 13:39 aborts.
 *
 * `X-Kookr-Actor` is the HTTP convention (mirrors the existing
 * `X-Kookr-Launch-Source` header on `POST /api/tasks`). Callers should send a
 * short caller id: `lucy-supervisor`, `dashboard`, `agent:<taskId>`, `cli`.
 * An absent/blank id does NOT reject the request (backward compatible) — it
 * resolves to `'unattributed'` and logs one warning per source per process
 * boot, not per request, so a chatty unattributed caller cannot spam logs.
 */

export { SUPERVISOR_ACTOR_HEADER, UNATTRIBUTED_ACTOR_ID };

/** Re-exported for call sites that only need the header name as a plain string. */
export const ACTOR_HEADER = SUPERVISOR_ACTOR_HEADER;

export type LifecycleActorSource = 'websocket' | 'api' | 'unknown';

export interface LifecycleAuditActor {
  source: LifecycleActorSource;
  actorId: string;
}

/** Defensive cap so a pathological header value can't bloat audit.jsonl rows. */
const MAX_ACTOR_ID_LENGTH = 128;

const warnedSources = new Set<LifecycleActorSource>();

/** Test-only: clears the per-boot warned-sources dedup set between test cases. */
export function resetActorAttributionWarningsForTests(): void {
  warnedSources.clear();
}

/**
 * Resolve the attributed actor for a mutating request from a raw caller-
 * supplied id (an `X-Kookr-Actor` header value for HTTP, a WS connection id
 * for the WebSocket transport). Never rejects — an absent/blank id resolves
 * to `'unattributed'` and logs a one-time-per-boot warning for that source.
 */
export function resolveLifecycleActor(
  source: LifecycleActorSource,
  rawActorId: string | null | undefined,
): LifecycleAuditActor {
  const trimmed = rawActorId?.trim();
  if (trimmed) {
    return { source, actorId: trimmed.slice(0, MAX_ACTOR_ID_LENGTH) };
  }
  if (!warnedSources.has(source)) {
    warnedSources.add(source);
    console.warn(
      `[actor-attribution] mutating '${source}' task-lifecycle request with no caller id `
      + `(missing '${SUPERVISOR_ACTOR_HEADER}' header on HTTP) — recording actor as `
      + `'${UNATTRIBUTED_ACTOR_ID}'. Identify the caller (e.g. lucy-supervisor, dashboard, cli) `
      + 'to keep audit.jsonl forensics usable.',
    );
  }
  return { source, actorId: UNATTRIBUTED_ACTOR_ID };
}
