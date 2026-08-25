import type { AgentType } from '../core/agent-types.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';

/** Default hard ceiling on one adapter launch (180 seconds). */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 180_000;

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
    reapGuard?: { reaped: boolean };
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
    if (timedOut) launchPromise.then(
      (sessionId) => {
        if (ctx.reapGuard) {
          if (ctx.reapGuard.reaped) return;
          ctx.reapGuard.reaped = true;
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
