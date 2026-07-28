/**
 * Issue #1391: re-entrancy-guarded SIGINT/SIGTERM handler for the standalone
 * relay process. Mirrors the main-server pattern in `src/server/shutdown.ts`
 * but only needs to call `RelayServerHandle.close()` (WS 1001 + HTTP drain +
 * SQLite close/WAL checkpoint) with a bounded grace timeout.
 *
 * Lives in its own module so unit tests can exercise the handler without
 * triggering `server.ts`'s main-entry listen side effect.
 */

export interface RelayShutdownHandlerDeps {
  close: () => Promise<void>;
  exit?: (code: number) => void;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Force-exit deadline if `close()` hangs. Default 30s (k8s grace period). */
  graceMs?: number;
}

export const DEFAULT_RELAY_SHUTDOWN_GRACE_MS = 30_000;

/**
 * Build a re-entrancy-guarded relay shutdown handler.
 *
 * First signal runs `close()` once, then `exit(0)`. A second signal during
 * shutdown force-exits(1) without re-invoking `close()`. A hung `close()` is
 * also force-exited after `graceMs` so the process cannot wedge.
 */
export function createRelayShutdownHandler(
  deps: RelayShutdownHandlerDeps,
): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const logger = deps.logger ?? console;
  const graceMs = deps.graceMs ?? DEFAULT_RELAY_SHUTDOWN_GRACE_MS;
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      logger.warn(`[relay] ${signal} received again during shutdown — forcing immediate exit.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.log(`[relay] ${signal} received. Shutting down...`);

    const forceTimer = setTimeout(() => {
      logger.error(`[relay] shutdown timed out after ${graceMs}ms — forcing exit.`);
      exit(1);
    }, graceMs);
    // Don't keep the process alive solely for the force-exit timer.
    forceTimer.unref();

    try {
      await deps.close();
      clearTimeout(forceTimer);
      logger.log('[relay] closed.');
      exit(0);
    } catch (err) {
      clearTimeout(forceTimer);
      logger.error(`[relay] shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      exit(1);
    }
  };
}

/** Wire SIGINT/SIGTERM to a shutdown handler (main-entry bootstrap). */
export function installRelayProcessSignalHandlers(
  shutdown: (signal: string) => void | Promise<void>,
  processRef: Pick<NodeJS.Process, 'on'> = process,
): void {
  processRef.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  processRef.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}
