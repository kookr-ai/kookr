/**
 * Race a promise against a wall-clock deadline. Resolves with the promise's
 * value if it settles within `timeoutMs`, otherwise resolves with
 * `fallback`. Rejections from `promise` propagate unchanged — callers that
 * want to swallow them must catch at the call site, so a future change that
 * adds a reject path cannot silently masquerade as a "timed out" result.
 *
 * Always clears the deadline timer on settle so the helper never keeps the
 * event loop alive past the awaiting caller.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        // Node-only: do not keep the event loop alive solely for this
        // fallback timer. No-op in browser-like runtimes where the timer
        // handle is a number.
        if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref();
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
