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
      `(agent ${agentType}, task ${taskId}) — launch abandoned and task cleaned up`,
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
): void {
  guard.sessionId = sessionId;
  if (guard.timedOut) {
    void reapLateLaunchSession(guard, adapter, agentType, taskId, sessionId).catch(() => undefined);
  }
}

function reapLateLaunchSession(
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
    })
    .finally(() => {
      if (!guard.reaped) guard.reapPromise = undefined;
    });
  guard.reapPromise = attempt;
  return attempt;
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
          void reapLateLaunchSession(
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
            void reapLateLaunchSession(
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
