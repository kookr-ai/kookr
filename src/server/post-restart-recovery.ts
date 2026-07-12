/**
 * Post-restart recovery orchestrator (kookr-ai/kookr#1345).
 *
 * After a Kookr restart the dtach masters and agent processes are still alive
 * (they were detached via setsid), and reconcile re-registers the surviving
 * sessions. But a resumed internal attach can come up *wedged*: the process and
 * socket pass liveness while no terminal bytes, transcript records, or hook
 * events flow — a dangerous false-healthy state.
 *
 * This orchestrator drives {@link TerminalBackend.verifyRecoveredSession} for
 * every recovered session, concurrently, so one wedged session cannot block the
 * others. It derives whether each session was *expected to be working* from its
 * last observed turn state and hands that to the backend, which only recycles
 * the attach transport (never the agent) for sessions that should be producing
 * output but are silent. Unrecovered sessions surface as the distinct
 * `session-recovery-unverified` backend finding, separate from the watchdog's
 * generic `stale_agent`.
 */
import type { TerminalBackend, VerifyRecoveredSessionResult } from '../adapters/terminal-backend.js';
import type { TaskStore } from '../core/tasks.js';
import type { TurnState } from '../shared/protocol.js';

export interface PostRestartRecoveryDeps {
  terminalBackend: TerminalBackend;
  taskStore: TaskStore;
  /** Session names (dtach ids) that reconcile confirmed survived the restart. */
  resumedSessions: string[];
  /** Restart epoch (ms) stamped on every verification for correlation. */
  restartEpoch: number;
  /** Optional grace-window / settle-window / repair-cap overrides forwarded to the backend. */
  graceWindowMs?: number;
  settleWindowMs?: number;
  maxRepairAttempts?: number;
  /**
   * Max sessions verified at once. The per-session repair cap bounds attaches
   * within one session; this bounds the fleet-wide spawn burst at startup so a
   * host recovering many sessions cannot storm dtach. Defaults to
   * {@link DEFAULT_RECOVERY_CONCURRENCY}.
   */
  maxConcurrency?: number;
}

/** Default fleet-wide verification concurrency (see {@link PostRestartRecoveryDeps.maxConcurrency}). */
const DEFAULT_RECOVERY_CONCURRENCY = 8;

export interface PostRestartRecoverySummary {
  restartEpoch: number;
  /** One result per session the backend could verify. */
  verified: VerifyRecoveredSessionResult[];
  /** Sessions whose verification threw before producing a result. */
  errors: Array<{ sessionId: string; error: string }>;
  live: number;
  idle: number;
  repaired: number;
  unverified: number;
}

/**
 * A session is "expected to be working" — i.e. it should be producing terminal
 * bytes — only while its agent is mid-turn (`running`). Every other turn state
 * is a legitimately-quiet session: `completed_turn` (idle after a normal Stop),
 * `waiting_for_input` (parked on a question), `blocked` (permission/API stop),
 * or `unknown` (no events yet). Silence there is normal, so the backend must
 * NOT recycle their attach transport. An unknown/absent turn state is treated
 * as not-working so we never repeatedly repair a session we can't reason about.
 */
export function isExpectedWorking(turnState: TurnState | undefined): boolean {
  return turnState === 'running';
}

export async function runPostRestartRecovery(
  deps: PostRestartRecoveryDeps,
): Promise<PostRestartRecoverySummary> {
  const { terminalBackend, taskStore, resumedSessions, restartEpoch } = deps;

  const summary: PostRestartRecoverySummary = {
    restartEpoch,
    verified: [],
    errors: [],
    live: 0,
    idle: 0,
    repaired: 0,
    unverified: 0,
  };

  // Backends without a detachable transport (the fake bridge, future backends)
  // omit the method — nothing to verify.
  if (!terminalBackend.verifyRecoveredSession || resumedSessions.length === 0) {
    return summary;
  }

  const verifyOne = (sessionId: string): Promise<VerifyRecoveredSessionResult> => {
    const expectWorking = isExpectedWorking(turnStateFor(taskStore, sessionId));
    // Each verify is independent; wrap so a rejection carries the id.
    return terminalBackend
      .verifyRecoveredSession!(sessionId, {
        expectWorking,
        restartEpoch,
        ...(deps.graceWindowMs != null ? { graceWindowMs: deps.graceWindowMs } : {}),
        ...(deps.settleWindowMs != null ? { settleWindowMs: deps.settleWindowMs } : {}),
        ...(deps.maxRepairAttempts != null ? { maxRepairAttempts: deps.maxRepairAttempts } : {}),
      })
      .catch((err: unknown) => {
        throw new SessionVerifyError(sessionId, err instanceof Error ? err.message : String(err));
      });
  };

  // Bound the fleet-wide spawn burst: a worker pool of at most `limit` concurrent
  // verifications, so a host recovering many sessions does not storm dtach at the
  // most resource-constrained instant (startup). One session's failure never
  // blocks the others — each result is captured independently.
  const limit = Math.max(1, deps.maxConcurrency ?? DEFAULT_RECOVERY_CONCURRENCY);
  const settled: PromiseSettledResult<VerifyRecoveredSessionResult>[] = new Array(
    resumedSessions.length,
  );
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= resumedSessions.length) return;
      try {
        settled[index] = { status: 'fulfilled', value: await verifyOne(resumedSessions[index]) };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, resumedSessions.length) }, () => worker()));

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const result = outcome.value;
      summary.verified.push(result);
      switch (result.classification) {
        case 'recovered-live':
          if (result.repairAttempts > 0) summary.repaired += 1;
          else summary.live += 1;
          break;
        case 'recovered-idle':
          summary.idle += 1;
          break;
        case 'recovered-unverified':
          summary.unverified += 1;
          break;
      }
    } else {
      const reason = outcome.reason;
      if (reason instanceof SessionVerifyError) {
        summary.errors.push({ sessionId: reason.sessionId, error: reason.detail });
      } else {
        summary.errors.push({
          sessionId: 'unknown',
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
  }

  logSummary(summary);
  return summary;
}

function turnStateFor(taskStore: TaskStore, sessionId: string): TurnState | undefined {
  const task = taskStore.findTaskBySession(sessionId);
  if (!task) return undefined;
  return task.sessions.find((s) => s.tmuxSession === sessionId)?.lastTurnState;
}

function logSummary(summary: PostRestartRecoverySummary): void {
  const { live, idle, repaired, unverified, errors } = summary;
  if (live + idle + repaired + unverified + errors.length === 0) return;
  console.log(
    `[post-restart-recovery] Verified ${summary.verified.length} recovered session(s): `
      + `${live} live, ${idle} idle, ${repaired} repaired, ${unverified} unverified`
      + (errors.length > 0 ? `, ${errors.length} errored` : ''),
  );
  // Unverified sessions are the actionable finding — a live master + agent whose
  // attach transport could not be revived. Log each distinctly (the backend also
  // emitted `session-recovery-unverified`, which is NOT `stale_agent`).
  for (const result of summary.verified) {
    if (result.classification !== 'recovered-unverified') continue;
    console.warn(
      `[post-restart-recovery] Session ${result.sessionId} UNVERIFIED after `
        + `${result.repairAttempts} repair attempt(s): ${result.failureReason ?? 'unknown'} `
        + `(masterPid=${result.masterPid}, agentPid=${result.agentPid ?? 'unknown'} still alive; `
        + `agent + conversation preserved)`,
    );
  }
  for (const { sessionId, error } of summary.errors) {
    console.warn(`[post-restart-recovery] Session ${sessionId} verification errored: ${error}`);
  }
}

/** Carries the session id through a rejected `verifyRecoveredSession` call. */
class SessionVerifyError extends Error {
  constructor(
    readonly sessionId: string,
    readonly detail: string,
  ) {
    super(`verifyRecoveredSession failed for ${sessionId}: ${detail}`);
    this.name = 'SessionVerifyError';
  }
}
