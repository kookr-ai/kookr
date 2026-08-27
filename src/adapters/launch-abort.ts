/**
 * Cooperative cancellation for an in-flight adapter launch (issue #2766).
 *
 * The launch-timeout race aborts this signal when the configured ceiling
 * expires. Adapters check it around session creation and prompt delivery so a
 * timed-out launch stops creating or acknowledging a terminal instead of
 * racing `addSession` after the caller has already abandoned the launch.
 */

/** Thrown when an adapter observes that its launch AbortSignal has fired. */
export class LaunchAbortedError extends Error {
  readonly code = 'launch_aborted';

  constructor(sessionId?: string) {
    super(
      sessionId
        ? `Launch cancelled after session ${sessionId} was created`
        : 'Launch cancelled before session creation settled',
    );
    this.name = 'LaunchAbortedError';
  }
}

/** Throw if the launch signal is already aborted. */
export function throwIfLaunchAborted(signal: AbortSignal | undefined, sessionId?: string): void {
  if (!signal?.aborted) return;
  throw new LaunchAbortedError(sessionId);
}

/**
 * Bound an in-flight adapter step (prompt delivery, agent-boot wait) to the
 * launch AbortSignal so cancellation is observed during the wait, not only
 * after it returns.
 */
export async function raceAgainstLaunchAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  sessionId?: string,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw new LaunchAbortedError(sessionId);
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LaunchAbortedError(sessionId));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
