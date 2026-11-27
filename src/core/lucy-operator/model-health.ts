/**
 * How Lucy's language model is doing, and the circuit breaker that keeps a dead model from making
 * every turn wait.
 *
 * One instance is shared by every operator model call in the server (her conversation and the
 * writers of a launch, a reply and an answer), because they all reach the same provider. After
 * {@link LUCY_BREAKER_FAILURES} failures in a row the breaker opens for {@link LUCY_BREAKER_OPEN_MS}:
 * a call during that time fails at once with a `unavailable` error and never reaches the provider, so
 * the operator waits milliseconds instead of seconds. When the time is up the next call goes through;
 * a success closes the breaker, another failure opens it again. Nothing is retried here, and no
 * provider is excluded: which provider serves her is the routing rule on the OpenRouter account.
 *
 * The snapshot feeds `GET /api/health` (`lucyOperator`), so the model's state is visible without
 * asking her anything.
 */

import { plainFailureReason } from './model-failure.js';
import { LucyModelError, type LucyModelErrorDetail, type LucyModelEvent, type LucyModelPort } from './model-port.js';

export const LUCY_BREAKER_FAILURES = 2;
export const LUCY_BREAKER_OPEN_MS = 60_000;

export interface LucyModelHealthSnapshot {
  /** ISO-8601, or null when no call has succeeded since the server started. */
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** The last failure in one safe sentence (the one the operator is shown), or null. */
  lastFailure: string | null;
  /** True while calls are refused without reaching the provider. */
  breakerOpen: boolean;
}

export interface LucyModelHealth {
  /** Wrap a model port: calls are refused while the breaker is open, and every outcome is recorded. */
  guard(port: LucyModelPort): LucyModelPort;
  /** Record a failure that the wrapped port could not see (a call abandoned by the turn's first-token deadline). */
  recordFailure(err: unknown): void;
  snapshot(): LucyModelHealthSnapshot;
}

export function createLucyModelHealth(now: () => number = Date.now): LucyModelHealth {
  let consecutiveFailures = 0;
  let openUntil = 0;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  let lastFailure: string | null = null;
  let lastDetail: LucyModelErrorDetail | undefined;

  const recordFailure = (err: unknown): void => {
    // A call the caller cancelled, and a refusal by the breaker itself, say nothing about the provider.
    if (err instanceof LucyModelError && (err.kind === 'aborted' || err.kind === 'unavailable')) return;
    const at = now();
    consecutiveFailures += 1;
    lastFailureAt = at;
    lastFailure = plainFailureReason(err);
    lastDetail = err instanceof LucyModelError ? { ...err.detail, ...(err.status !== undefined && err.detail?.status === undefined ? { status: err.status } : {}) } : undefined;
    if (consecutiveFailures >= LUCY_BREAKER_FAILURES) openUntil = at + LUCY_BREAKER_OPEN_MS;
  };
  const recordSuccess = (): void => {
    consecutiveFailures = 0;
    openUntil = 0;
    lastSuccessAt = now();
  };

  return {
    guard(port) {
      return async function* guarded(request): AsyncGenerator<LucyModelEvent, void, void> {
        if (now() < openUntil) {
          throw new LucyModelError('unavailable', 'Lucy model circuit breaker is open: not calling the provider', undefined, lastDetail);
        }
        try {
          for await (const event of port(request)) {
            if (event.type === 'finish') recordSuccess();
            yield event;
          }
        } catch (err) {
          recordFailure(err);
          throw err;
        }
      };
    },
    recordFailure,
    snapshot: () => ({
      lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
      lastFailureAt: lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
      lastFailure,
      breakerOpen: now() < openUntil,
    }),
  };
}
