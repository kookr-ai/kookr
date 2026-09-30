import { randomUUID } from 'node:crypto';
import type { AgentType } from '../core/agent-types.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';

/** Default hard ceiling on one adapter launch (180 seconds). */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 180_000;

/** Allocate the terminal id before a crash-sensitive launch is persisted. */
export function allocateLaunchSessionId(): string {
  return `kookr-${randomUUID().slice(0, 8)}`;
}

/** Error raised when an adapter launch does not settle before its hard bound. */
export class LaunchTimeoutError extends Error {
  readonly code = 'launch_timeout';

  constructor(agentType: string, taskId: string, timeoutMs: number) {
    super(
      `Agent launch timed out after ${Math.round(timeoutMs / 1000)}s ` +
      `(agent ${agentType}, task ${taskId}) — launch abandoned`,
    );
    this.name = 'LaunchTimeoutError';
  }
}

/** Type guard for {@link LaunchTimeoutError}. */
export function isLaunchTimeoutError(err: unknown): err is LaunchTimeoutError {
  return err instanceof LaunchTimeoutError;
}

export interface LaunchReapGuard {
  reaped: boolean;
  /** Shared physical-stop attempt; `reaped` becomes true only on resolution. */
  reapPromise?: Promise<void>;
  timedOut?: boolean;
  sessionId?: string;
}

/** Record a session created during a bounded launch and reap it if abandoned. */
export function noteLaunchSession(
  guard: LaunchReapGuard,
  adapter: Pick<AgentAdapter, 'stop'>,
  agentType: AgentType,
  taskId: string,
  sessionId: string,
): Promise<void> | undefined {
  guard.sessionId = sessionId;
  if (guard.timedOut) {
    return reapLaunchSession(guard, adapter, agentType, taskId, sessionId);
  }
  return undefined;
}

/**
 * Stop the physical session reported by this launch exactly once. Callers may
 * await the shared promise; unlike a speculative stop of a preallocated id,
 * resolution proves cleanup because `onSessionCreated` already proved the
 * terminal exists.
 */
export function reapLaunchSession(
  guard: LaunchReapGuard,
  adapter: Pick<AgentAdapter, 'stop'>,
  agentType: AgentType,
  taskId: string,
  sessionId: string,
): Promise<void> {
  if (guard.reaped) return Promise.resolve();
  if (guard.reapPromise) return guard.reapPromise;
  console.warn(
    `[launch] adapter ${agentType} settled LATE after timeout for task ${taskId} ` +
    `(session ${sessionId}) — stopping orphaned session`,
  );
  const attempt = Promise.resolve(adapter.stop(sessionId))
    .then(() => {
      guard.reaped = true;
    })
    .catch((stopErr) => {
      console.warn(
        `[launch] failed to stop late-settled session ${sessionId}: ` +
        `${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
      );
      throw stopErr;
    });
  guard.reapPromise = attempt;
  return attempt;
}

/**
 * Task/session bookkeeping for a session that an abandoned launch reported
 * after its timeout. Each launch path supplies its own persistence and
 * recovery effects through these collaborators; the shared owner
 * ({@link reapAbandonedLaunchSession}) sequences them around the physical stop.
 */
export interface AbandonedLaunchSessionBookkeeping {
  /**
   * Link the late session to its task as a reaper-owned terminal leak and mark
   * its status unresolved. Throwing signals the link failed; the physical stop
   * still runs and remains the source of truth.
   */
  link(sessionId: string): void;
  /** Mark the linked session `aborted` after a proven physical stop. */
  markAborted(sessionId: string): void;
  /** Best-effort recovery when {@link link} throws. */
  onLinkError?(sessionId: string, err: unknown): void;
  /**
   * Runs after linking and before the shared stop is awaited (e.g. an operator
   * intent line). It must not throw.
   */
  beforeReap?(sessionId: string): void;
  /**
   * Runs after the session is marked `aborted` on a proven stop (e.g. a success
   * audit row or a state flush).
   */
  onReaped?(sessionId: string): void | Promise<void>;
  /**
   * Runs when the shared stop rejects; the session stays unresolved and owned so
   * the next reaper sweep retries it (e.g. a warning or probe-ownership
   * retention plus a flush).
   */
  onReapFailed?(sessionId: string, err: unknown): void | Promise<void>;
}

/**
 * Own the bookkeeping for a session an abandoned launch reported after its
 * timeout: link it to the task as a reaper-owned terminal leak, keep its status
 * unresolved while the shared physical stop is pending, and mark it `aborted`
 * only once that stop resolves. The stop itself is {@link reapLaunchSession}, so
 * a late creation and a late promise resolution share one physical attempt.
 * Path-specific effects (success auditing, state flushes, dependency-probe
 * retention) are delegated to {@link AbandonedLaunchSessionBookkeeping} so each
 * caller keeps its exact audit, persistence, and recovery behavior and order.
 *
 * Idempotent with respect to the guard: if a stop was already started via the
 * guard (e.g. by {@link noteLaunchSession} on late creation), this re-derives
 * the same shared promise instead of starting a second stop.
 */
export function reapAbandonedLaunchSession(
  guard: LaunchReapGuard,
  adapter: Pick<AgentAdapter, 'stop'>,
  agentType: AgentType,
  taskId: string,
  sessionId: string,
  bookkeeping: AbandonedLaunchSessionBookkeeping,
): void {
  try {
    bookkeeping.link(sessionId);
  } catch (linkErr) {
    bookkeeping.onLinkError?.(sessionId, linkErr);
  }
  bookkeeping.beforeReap?.(sessionId);
  void reapLaunchSession(guard, adapter, agentType, taskId, sessionId).then(
    async () => {
      try {
        bookkeeping.markAborted(sessionId);
      } catch {
        // A concurrent task purge may remove the bookkeeping after the physical
        // stop resolves. Cleanup is already proven in that case.
      }
      await bookkeeping.onReaped?.(sessionId);
    },
    async (stopErr) => {
      await bookkeeping.onReapFailed?.(sessionId, stopErr);
    },
  );
}

/**
 * Race one adapter launch against a hard timeout. A late session id is stopped
 * best-effort so a recovery timeout cannot leave an unowned terminal session.
 */
export async function raceLaunchAgainstTimeout(
  launchPromise: Promise<string>,
  timeoutMs: number,
  ctx: {
    taskId: string;
    agentType: AgentType;
    adapter: Pick<AgentAdapter, 'stop'>;
    /** Shared reap guard for launch-service's onSessionCreated path. */
    reapGuard?: LaunchReapGuard;
    /** Reap a session reported before the adapter promise settles. */
    reapKnownSessionOnTimeout?: boolean;
    /**
     * Aborted when the timeout fires so adapters can stop session creation
     * and prompt delivery instead of racing a late `addSession`.
     */
    abort?: AbortController;
  },
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      launchPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (ctx.reapGuard) ctx.reapGuard.timedOut = true;
          ctx.abort?.abort();
          reject(new LaunchTimeoutError(ctx.agentType, ctx.taskId, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      if (ctx.reapGuard) {
        ctx.reapGuard.timedOut = true;
        if (ctx.reapKnownSessionOnTimeout && ctx.reapGuard.sessionId) {
          void reapLaunchSession(
            ctx.reapGuard,
            ctx.adapter,
            ctx.agentType,
            ctx.taskId,
            ctx.reapGuard.sessionId,
          ).catch(() => undefined);
        }
      }
      launchPromise.then(
        (sessionId) => {
          if (ctx.reapGuard) {
            void reapLaunchSession(
              ctx.reapGuard,
              ctx.adapter,
              ctx.agentType,
              ctx.taskId,
              sessionId,
            ).catch(() => undefined);
            return;
          }
          console.warn(
            `[launch] adapter ${ctx.agentType} settled LATE after timeout for task ${ctx.taskId} ` +
            `(session ${sessionId}) — stopping orphaned session`,
          );
          void Promise.resolve(ctx.adapter.stop(sessionId)).catch((stopErr) => {
            console.warn(
              `[launch] failed to stop late-settled session ${sessionId}: ` +
              `${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
            );
          });
        },
        (err) => {
          console.warn(
            `[launch] abandoned launch for task ${ctx.taskId} rejected after timeout (ignored): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    }
  }
}
